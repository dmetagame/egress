// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EgressExecutor} from "../../src/EgressExecutor.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {IATokenPermit} from "../../src/interfaces/IATokenPermit.sol";
import {IAavePool} from "../../src/interfaces/IAavePool.sol";

interface IAavePoolFixture is IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
    function setUserEMode(uint8 categoryId) external;
}

interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

abstract contract XLayerForkBase is Test {
    uint256 internal constant FORK_BLOCK = 67_881_241;
    string internal constant XLAYER_RPC = "https://rpc.xlayer.tech";

    address internal constant ADDRESSES_PROVIDER = 0xdFf435BCcf782f11187D3a4454d96702eD78e092;
    address internal constant AAVE_POOL = 0xE3F3Caefdd7180F884c01E57f65Df979Af84f116;
    address internal constant AAVE_ORACLE = 0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6;
    address internal constant XBETH = 0xAFeab3B85B6A56cF5F02317F0f7A23340eb983D7;
    address internal constant XETH = 0xE7B000003A45145decf8a28FC755aD5eC5EA025A;
    address internal constant AXBETH = 0xe9e78053f1Ef084f8cD01dBE8ccE95c6b0944d32;
    address internal constant VDEBT_XETH = 0xB756Fc7065369602f2cCb8356283E8b997fDfe2a;
    address internal constant UNISWAP_FACTORY = 0x4B2ab38DBF28D31D467aA8993f6c2585981D6804;
    address internal constant SWAP_ROUTER = 0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA;
    address internal constant QUOTER_V2 = 0xD1b797D92d87B688193A2B976eFc8D577D204343;
    address internal constant SWAP_POOL = 0x84d4DbEebFf5F77c63F36bD0dCb18121Aa9aC8fc;
    uint24 internal constant POOL_FEE = 100;
    uint8 internal constant EMODE_CATEGORY = 5;
    uint256 internal constant MAX_FLASH_LOAN_PREMIUM_BPS = 5;

    uint256 internal constant BORROWER_KEY = 0xE66155;
    uint256 internal constant EXECUTOR_KEY = 0xE66156;
    uint256 internal constant ATTACKER_KEY = 0xE66157;

    address internal borrower;
    address internal keeper;
    address internal attacker;
    EgressExecutor internal egress;

    function setUp() public virtual {
        vm.createSelectFork(XLAYER_RPC, FORK_BLOCK);
        borrower = vm.addr(BORROWER_KEY);
        keeper = vm.addr(EXECUTOR_KEY);
        attacker = vm.addr(ATTACKER_KEY);
        egress = _deployEgress();
    }

    function _deployEgress() internal returns (EgressExecutor) {
        return new EgressExecutor(
            EgressExecutor.ProtocolConfig({
                pool: AAVE_POOL,
                poolAddressesProvider: ADDRESSES_PROVIDER,
                aaveOracle: AAVE_ORACLE,
                xeth: XETH,
                xbEth: XBETH,
                aXbEth: AXBETH,
                variableDebtXeth: VDEBT_XETH,
                uniswapFactory: UNISWAP_FACTORY,
                swapRouter: SWAP_ROUTER,
                swapPool: SWAP_POOL,
                poolFee: POOL_FEE
            })
        );
    }

    function _createPosition(uint256 collateral, uint256 debt) internal {
        // FORK SIMULATION ONLY: seed the synthetic borrower with xBETH while retaining the
        // production Aave, token, oracle, router, pool bytecode, configuration, and liquidity.
        deal(XBETH, borrower, collateral);
        vm.startPrank(borrower);
        IERC20(XBETH).approve(AAVE_POOL, collateral);
        IAavePoolFixture(AAVE_POOL).supply(XBETH, collateral, borrower, 0);
        IAavePoolFixture(AAVE_POOL).setUserEMode(EMODE_CATEGORY);
        IAavePoolFixture(AAVE_POOL).borrow(XETH, debt, 2, 0, borrower);
        vm.stopPrank();
    }

    function _authorization(
        uint256 repayAmount,
        uint256 collateralAmount,
        uint256 quotedAmountOut,
        uint256 maxSlippageBps,
        uint256 minPostHealthFactor,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (EgressExecutor.Authorization memory authorization) {
        uint256 minSwapOut = quotedAmountOut * (10_000 - maxSlippageBps) / 10_000;
        authorization = EgressExecutor.Authorization({
            user: borrower,
            executor: keeper,
            repayAmount: repayAmount,
            collateralAmount: collateralAmount,
            maxRepayment: repayAmount,
            maxCollateral: collateralAmount,
            expectedSwapOut: quotedAmountOut,
            minSwapOut: minSwapOut,
            maxSlippageBps: maxSlippageBps,
            maxFlashLoanPremiumBps: MAX_FLASH_LOAN_PREMIUM_BPS,
            minPostHealthFactor: minPostHealthFactor,
            deadline: deadline,
            nonce: nonce,
            revocationNonce: egress.revocationNonces(borrower)
        });
    }

    function _request(EgressExecutor.Authorization memory authorization)
        internal
        view
        returns (EgressExecutor.ExecutionRequest memory request)
    {
        request = EgressExecutor.ExecutionRequest({
            authorization: authorization,
            authorizationSignature: _signAuthorization(authorization, BORROWER_KEY),
            collateralPermit: _signPermit(authorization.collateralAmount, authorization.deadline, BORROWER_KEY)
        });
    }

    function _signAuthorization(EgressExecutor.Authorization memory authorization, uint256 key)
        internal
        view
        returns (EgressExecutor.Signature memory signature)
    {
        bytes32 digest = egress.authorizationDigest(authorization);
        (signature.v, signature.r, signature.s) = vm.sign(key, digest);
    }

    function _signPermit(uint256 collateralAmount, uint256 deadline, uint256 key)
        internal
        view
        returns (EgressExecutor.PermitData memory permitData)
    {
        IATokenPermit token = IATokenPermit(AXBETH);
        bytes32 structHash = keccak256(
            abi.encode(
                token.PERMIT_TYPEHASH(), borrower, address(egress), collateralAmount, token.nonces(borrower), deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (permitData.v, permitData.r, permitData.s) = vm.sign(key, digest);
        permitData.deadline = deadline;
    }

    function _quote(uint256 collateralAmount) internal returns (uint256 amountOut) {
        (amountOut,,,) = IQuoterV2(QUOTER_V2)
            .quoteExactInputSingle(
                IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: XBETH, tokenOut: XETH, amountIn: collateralAmount, fee: POOL_FEE, sqrtPriceLimitX96: 0
            })
            );
    }

    function _execute(EgressExecutor.ExecutionRequest memory request) internal {
        vm.prank(keeper);
        egress.execute(request);
    }

    function _healthFactor(address user) internal view returns (uint256 healthFactor) {
        (,,,,, healthFactor) = IAavePool(AAVE_POOL).getUserAccountData(user);
    }

    function _oraclePrice(address asset) internal view returns (uint256) {
        return IAaveOracle(AAVE_ORACLE).getAssetPrice(asset);
    }

    function _assertAtomicState(
        uint256 debtBefore,
        uint256 collateralBefore,
        uint256 userXethBefore,
        uint256 permitNonceBefore,
        uint256 authorizationNonce,
        uint256 expectedAllowance
    ) internal view {
        assertEq(IERC20(VDEBT_XETH).balanceOf(borrower), debtBefore, "debt must roll back");
        assertEq(IERC20(AXBETH).balanceOf(borrower), collateralBefore, "collateral must roll back");
        assertEq(IERC20(XETH).balanceOf(borrower), userXethBefore, "user xETH must roll back");
        assertEq(IATokenPermit(AXBETH).nonces(borrower), permitNonceBefore, "permit nonce must roll back");
        assertEq(egress.authorizationUsed(borrower, authorizationNonce), false, "authorization use must roll back");
        assertEq(IERC20(AXBETH).allowance(borrower, address(egress)), expectedAllowance, "allowance must roll back");
        assertEq(IERC20(XETH).balanceOf(address(egress)), 0, "executor xETH residue");
        assertEq(IERC20(XBETH).balanceOf(address(egress)), 0, "executor xBETH residue");
        assertEq(IERC20(AXBETH).balanceOf(address(egress)), 0, "executor aXbETH residue");
    }
}
