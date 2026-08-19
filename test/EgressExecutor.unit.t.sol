// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EgressExecutor} from "../src/EgressExecutor.sol";

contract MockPool {
    address public immutable ADDRESSES_PROVIDER;

    constructor(address provider) {
        ADDRESSES_PROVIDER = provider;
    }
}

contract MockProvider {
    address public pool;
    address public priceOracle;

    function setPool(address value) external {
        pool = value;
    }

    function getPool() external view returns (address) {
        return pool;
    }

    function setPriceOracle(address value) external {
        priceOracle = value;
    }

    function getPriceOracle() external view returns (address) {
        return priceOracle;
    }
}

contract MockOracle {
    function getAssetPrice(address) external pure returns (uint256) {
        return 1e8;
    }
}

contract MockReserveToken {
    address public immutable POOL;
    address public immutable UNDERLYING_ASSET_ADDRESS;

    constructor(address pool, address underlying) {
        POOL = pool;
        UNDERLYING_ASSET_ADDRESS = underlying;
    }
}

contract MockFactory {
    address public pool;

    function setPool(address value) external {
        pool = value;
    }

    function getPool(address, address, uint24) external view returns (address) {
        return pool;
    }
}

contract MockRouter {
    address public immutable factory;

    constructor(address value) {
        factory = value;
    }
}

contract MockSwapPool {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    constructor(address factory_, address token0_, address token1_, uint24 fee_) {
        factory = factory_;
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }
}

contract EgressExecutorUnitTest is Test {
    uint256 internal constant USER_KEY = 0xE66101;
    uint256 internal constant EXECUTOR_KEY = 0xE66102;
    uint256 internal constant ATTACKER_KEY = 0xE66103;
    address internal constant XETH = address(0x1001);
    address internal constant XBETH = address(0x1002);
    uint24 internal constant POOL_FEE = 100;

    address internal user;
    address internal executor;
    address internal attacker;
    EgressExecutor internal egress;

    function setUp() external {
        vm.warp(1_000_000);
        user = vm.addr(USER_KEY);
        executor = vm.addr(EXECUTOR_KEY);
        attacker = vm.addr(ATTACKER_KEY);

        MockProvider provider = new MockProvider();
        MockPool pool = new MockPool(address(provider));
        provider.setPool(address(pool));
        MockOracle oracle = new MockOracle();
        provider.setPriceOracle(address(oracle));

        MockReserveToken aXbEth = new MockReserveToken(address(pool), XBETH);
        MockReserveToken variableDebtXeth = new MockReserveToken(address(pool), XETH);
        MockFactory factory = new MockFactory();
        MockRouter router = new MockRouter(address(factory));
        MockSwapPool swapPool = new MockSwapPool(address(factory), XBETH, XETH, POOL_FEE);
        factory.setPool(address(swapPool));

        egress = new EgressExecutor(
            EgressExecutor.ProtocolConfig({
                pool: address(pool),
                poolAddressesProvider: address(provider),
                aaveOracle: address(oracle),
                xeth: XETH,
                xbEth: XBETH,
                aXbEth: address(aXbEth),
                variableDebtXeth: address(variableDebtXeth),
                uniswapFactory: address(factory),
                swapRouter: address(router),
                swapPool: address(swapPool),
                poolFee: POOL_FEE
            })
        );
    }

    function testUserRevocationEpochIncrements() external {
        vm.prank(user);
        uint256 newEpoch = egress.revokeAuthorizations();

        assertEq(newEpoch, 1);
        assertEq(egress.revocationNonces(user), 1);
    }

    function testGuardianCanPauseAndUnpause() external {
        egress.setPaused(true);
        assertTrue(egress.paused());

        egress.setPaused(false);
        assertFalse(egress.paused());
    }

    function testNonGuardianCannotPause() external {
        vm.prank(attacker);
        vm.expectPartialRevert(EgressExecutor.NotGuardian.selector);
        egress.setPaused(true);
    }

    function testExpiredAuthorizationFailsBeforeExternalCalls() external {
        EgressExecutor.Authorization memory authorization = _authorization(block.timestamp - 1, 1);
        EgressExecutor.ExecutionRequest memory request = _request(authorization, USER_KEY, authorization.deadline);

        vm.prank(executor);
        vm.expectPartialRevert(EgressExecutor.AuthorizationExpired.selector);
        egress.execute(request);
    }

    function testWrongExecutorFailsBeforeExternalCalls() external {
        EgressExecutor.Authorization memory authorization = _authorization(block.timestamp + 1 hours, 2);
        EgressExecutor.ExecutionRequest memory request = _request(authorization, USER_KEY, authorization.deadline);

        vm.prank(attacker);
        vm.expectPartialRevert(EgressExecutor.UnauthorizedExecutor.selector);
        egress.execute(request);
    }

    function testInvalidSignerFailsBeforeExternalCalls() external {
        EgressExecutor.Authorization memory authorization = _authorization(block.timestamp + 1 hours, 3);
        EgressExecutor.ExecutionRequest memory request = _request(authorization, ATTACKER_KEY, authorization.deadline);

        vm.prank(executor);
        vm.expectPartialRevert(EgressExecutor.InvalidAuthorizationSigner.selector);
        egress.execute(request);
    }

    function testRevokedAuthorizationFailsBeforeExternalCalls() external {
        EgressExecutor.Authorization memory authorization = _authorization(block.timestamp + 1 hours, 4);
        EgressExecutor.ExecutionRequest memory request = _request(authorization, USER_KEY, authorization.deadline);
        vm.prank(user);
        egress.revokeAuthorizations();

        vm.prank(executor);
        vm.expectPartialRevert(EgressExecutor.AuthorizationRevoked.selector);
        egress.execute(request);
    }

    function testPermitDeadlineCannotPrecedeAuthorizationDeadline() external {
        EgressExecutor.Authorization memory authorization = _authorization(block.timestamp + 1 hours, 5);
        EgressExecutor.ExecutionRequest memory request = _request(authorization, USER_KEY, authorization.deadline - 1);

        vm.prank(executor);
        vm.expectPartialRevert(EgressExecutor.PermitExpiresBeforeAuthorization.selector);
        egress.execute(request);
    }

    function testInvalidFlashLoanPremiumCeilingFailsBeforeExternalCalls() external {
        EgressExecutor.Authorization memory authorization = _authorization(block.timestamp + 1 hours, 6);
        authorization.maxFlashLoanPremiumBps = 10_001;
        EgressExecutor.ExecutionRequest memory request = _request(authorization, USER_KEY, authorization.deadline);

        vm.prank(executor);
        vm.expectPartialRevert(EgressExecutor.InvalidFlashLoanPremiumBps.selector);
        egress.execute(request);
    }

    function testMinimumOutputMustCoverSignedPremiumCeiling() external {
        EgressExecutor.Authorization memory authorization = _authorization(block.timestamp + 1 hours, 7);
        uint256 maximumOwed = authorization.repayAmount
            + (authorization.repayAmount * authorization.maxFlashLoanPremiumBps + 9_999) / 10_000;
        authorization.minSwapOut = maximumOwed - 1;
        authorization.maxSlippageBps = 10_000;
        EgressExecutor.ExecutionRequest memory request = _request(authorization, USER_KEY, authorization.deadline);

        vm.prank(executor);
        vm.expectPartialRevert(EgressExecutor.SwapOutputBelowAuthorization.selector);
        egress.execute(request);
    }

    function testNonDivisibleRepaymentRequiresCeilingPremiumBeforeExternalCalls() external {
        EgressExecutor.Authorization memory authorization = _authorization(block.timestamp + 1 hours, 8);
        authorization.repayAmount = 1;
        authorization.maxRepayment = 1;
        authorization.expectedSwapOut = 2;
        authorization.minSwapOut = 1;
        authorization.maxSlippageBps = 10_000;
        authorization.maxFlashLoanPremiumBps = 5;
        EgressExecutor.ExecutionRequest memory request = _request(authorization, USER_KEY, authorization.deadline);

        vm.prank(executor);
        vm.expectPartialRevert(EgressExecutor.SwapOutputBelowAuthorization.selector);
        egress.execute(request);
    }

    function _authorization(uint256 deadline, uint256 nonce)
        internal
        view
        returns (EgressExecutor.Authorization memory authorization)
    {
        authorization = EgressExecutor.Authorization({
            user: user,
            executor: executor,
            repayAmount: 1 ether,
            collateralAmount: 1 ether,
            maxRepayment: 1 ether,
            maxCollateral: 1 ether,
            expectedSwapOut: 2 ether,
            minSwapOut: 1.9 ether,
            maxSlippageBps: 500,
            maxFlashLoanPremiumBps: 10,
            minPostHealthFactor: 1 ether,
            deadline: deadline,
            nonce: nonce,
            revocationNonce: egress.revocationNonces(user)
        });
    }

    function _request(EgressExecutor.Authorization memory authorization, uint256 signerKey, uint256 permitDeadline)
        internal
        view
        returns (EgressExecutor.ExecutionRequest memory request)
    {
        bytes32 digest = egress.authorizationDigest(authorization);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        request = EgressExecutor.ExecutionRequest({
            authorization: authorization,
            authorizationSignature: EgressExecutor.Signature({v: v, r: r, s: s}),
            collateralPermit: EgressExecutor.PermitData({deadline: permitDeadline, v: 27, r: bytes32(0), s: bytes32(0)})
        });
    }
}
