// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EgressExecutor} from "../src/EgressExecutor.sol";
import {
    Phase11AToken,
    Phase11AddressesProvider,
    Phase11AavePool,
    Phase11Oracle,
    Phase11QuoterV2,
    Phase11SwapFactory,
    Phase11SwapPool,
    Phase11SwapRouter,
    Phase11Token,
    Phase11VariableDebtToken
} from "../src/testnet/Phase11Compatibility.sol";

contract Phase11CompatibilityTest is Test {
    uint256 internal constant BORROWER_KEY = 0xE66190;
    uint256 internal constant KEEPER_KEY = 0xE66191;
    uint256 internal constant ATTESTOR_KEY = 0xE66192;
    uint256 internal constant COLLATERAL = 50 ether;
    uint256 internal constant DEBT = 44 ether;
    uint256 internal constant REPAY = 10.8 ether;
    uint256 internal constant COLLATERAL_SOLD = 10.8 ether;
    uint24 internal constant POOL_FEE = 100;

    Phase11Token internal xbEth;
    Phase11Token internal xeth;
    Phase11AddressesProvider internal provider;
    Phase11Oracle internal oracle;
    Phase11AavePool internal pool;
    Phase11AToken internal aXbEth;
    Phase11VariableDebtToken internal variableDebtXeth;
    Phase11SwapFactory internal factory;
    Phase11SwapRouter internal router;
    Phase11QuoterV2 internal quoter;
    Phase11SwapPool internal swapPool;
    EgressExecutor internal egress;
    address internal borrower;
    address internal keeper;
    address internal attestor;

    function setUp() external {
        vm.warp(1_000_000);
        borrower = vm.addr(BORROWER_KEY);
        keeper = vm.addr(KEEPER_KEY);
        attestor = vm.addr(ATTESTOR_KEY);

        xbEth = new Phase11Token("Egress Testnet xBETH", "txBETH", 18);
        xeth = new Phase11Token("Egress Testnet xETH", "txETH", 18);
        provider = new Phase11AddressesProvider();
        oracle = new Phase11Oracle();
        pool = new Phase11AavePool(address(provider), address(oracle), address(xbEth), address(xeth));
        aXbEth = new Phase11AToken(address(pool), address(xbEth));
        variableDebtXeth = new Phase11VariableDebtToken(address(pool), address(xeth));
        provider.configure(address(pool), address(oracle));
        pool.configureReserves(address(aXbEth), address(variableDebtXeth));
        xbEth.setMinter(address(pool), true);
        xeth.setMinter(address(pool), true);
        aXbEth.setMinter(address(pool), true);
        variableDebtXeth.setMinter(address(pool), true);
        oracle.setAssetPrice(address(xbEth), 1e8);
        oracle.setAssetPrice(address(xeth), 1e8);

        factory = new Phase11SwapFactory();
        router = new Phase11SwapRouter(address(factory));
        quoter = new Phase11QuoterV2(address(factory));
        swapPool = new Phase11SwapPool(
            address(factory), address(router), address(xbEth), address(xeth), POOL_FEE, 10_200, 10_000
        );
        factory.configure(address(swapPool), address(xbEth), address(xeth), POOL_FEE);
        xbEth.mint(address(swapPool), 1_000 ether);
        xeth.mint(address(swapPool), 1_000 ether);
        pool.seedPosition(borrower, COLLATERAL, DEBT);
        pool.seedFlashLiquidity(500 ether);

        egress = new EgressExecutor(
            EgressExecutor.ProtocolConfig({
                pool: address(pool),
                poolAddressesProvider: address(provider),
                aaveOracle: address(oracle),
                xeth: address(xeth),
                xbEth: address(xbEth),
                aXbEth: address(aXbEth),
                variableDebtXeth: address(variableDebtXeth),
                uniswapFactory: address(factory),
                swapRouter: address(router),
                swapPool: address(swapPool),
                poolFee: POOL_FEE
            })
        );
    }

    function testUnchangedEgressAutonomousFlowImprovesHealthOnCompatibilityStack() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(1);
        bytes32 policyId = _register(policy);
        uint256 quote = swapPool.quote(COLLATERAL_SOLD);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("phase11-compatibility-proof"), REPAY, COLLATERAL_SOLD, quote, 0);

        uint256 debtBefore = variableDebtXeth.balanceOf(borrower);
        uint256 healthBefore = _healthFactor(borrower);
        vm.prank(keeper);
        egress.executeAutonomous(request);
        uint256 debtAfter = variableDebtXeth.balanceOf(borrower);
        uint256 healthAfter = _healthFactor(borrower);

        (
            address stateUser,
            bool active,
            uint256 executionCount,,
            uint256 cumulativeRepayment,
            uint256 cumulativeCollateral,,
        ) = egress.policyStates(policyId);
        assertEq(stateUser, borrower);
        assertTrue(active);
        assertEq(executionCount, 1);
        assertEq(cumulativeRepayment, REPAY);
        assertEq(cumulativeCollateral, COLLATERAL_SOLD);
        assertEq(debtBefore - debtAfter, REPAY);
        assertGt(healthAfter, healthBefore);
        assertGe(healthAfter, policy.minPostHealthFactor);
        assertEq(aXbEth.balanceOf(address(egress)), 0);
        assertEq(xbEth.balanceOf(address(egress)), 0);
        assertEq(xeth.balanceOf(address(egress)), 0);
    }

    function testCompatibilityStackRejectsWrongPoolConfiguration() external {
        vm.expectRevert(EgressExecutor.InvalidProtocolConfiguration.selector);
        new EgressExecutor(
            EgressExecutor.ProtocolConfig({
                pool: address(pool),
                poolAddressesProvider: address(provider),
                aaveOracle: address(oracle),
                xeth: address(xeth),
                xbEth: address(xbEth),
                aXbEth: address(aXbEth),
                variableDebtXeth: address(variableDebtXeth),
                uniswapFactory: address(factory),
                swapRouter: address(router),
                swapPool: address(swapPool),
                poolFee: 500
            })
        );
    }

    function _policy(uint256 nonce) internal view returns (EgressExecutor.ProtectionPolicy memory policy) {
        policy = EgressExecutor.ProtectionPolicy({
            user: borrower,
            keeper: keeper,
            riskAttestor: attestor,
            protocolConfigHash: egress.PROTOCOL_CONFIG_HASH(),
            minimumRiskLevel: 3,
            maxRepaymentPerExecution: REPAY,
            maxCollateralPerExecution: COLLATERAL_SOLD,
            maxCumulativeRepayment: REPAY * 2,
            maxCumulativeCollateral: 12.5 ether,
            maxCollateralPercentageBps: 2_500,
            maxPositionDebt: 46 ether,
            maxSlippageBps: 100,
            maxOracleDeviationBps: 125,
            maxFlashLoanPremiumBps: 5,
            maxPreHealthFactor: 1.05 ether,
            minPostHealthFactor: 1.065 ether,
            cooldownSeconds: 0,
            maxExecutions: 1,
            maxRiskAgeSeconds: 15 minutes,
            maxClockSkewSeconds: 30,
            expiresAt: block.timestamp + 7 days,
            nonce: nonce,
            revocationNonce: egress.revocationNonces(borrower)
        });
    }

    function _register(EgressExecutor.ProtectionPolicy memory policy) internal returns (bytes32) {
        EgressExecutor.Signature memory policySignature = _signPolicy(policy, BORROWER_KEY);
        EgressExecutor.PermitData memory collateralPermit =
            _signPermit(policy.maxCumulativeCollateral, policy.expiresAt);
        vm.prank(keeper);
        return egress.registerProtectionPolicy(policy, policySignature, collateralPermit);
    }

    function _request(
        EgressExecutor.ProtectionPolicy memory policy,
        bytes32 riskEventId,
        uint256 repayAmount,
        uint256 collateralAmount,
        uint256 expectedSwapOut,
        uint256 executionNonce
    ) internal view returns (EgressExecutor.AutonomousExecutionRequest memory request) {
        uint256 deadline = block.timestamp + 5 minutes;
        request = EgressExecutor.AutonomousExecutionRequest({
            policy: policy,
            riskAttestation: _attestation(policy, riskEventId, deadline),
            execution: EgressExecutor.AutonomousExecution({
                repayAmount: repayAmount,
                collateralAmount: collateralAmount,
                expectedSwapOut: expectedSwapOut,
                minSwapOut: expectedSwapOut * (10_000 - policy.maxSlippageBps) / 10_000,
                deadline: deadline,
                executionNonce: executionNonce
            })
        });
    }

    function _attestation(EgressExecutor.ProtectionPolicy memory policy, bytes32 riskEventId, uint256 deadline)
        internal
        view
        returns (EgressExecutor.RiskAttestation memory attestation)
    {
        attestation = EgressExecutor.RiskAttestation({
            policyId: egress.protectionPolicyDigest(policy),
            riskEventId: riskEventId,
            verdictHash: keccak256(abi.encode("phase11-verdict", riskEventId)),
            evidenceHash: keccak256(abi.encode("phase11-evidence", riskEventId)),
            riskLevel: 3,
            issuedAt: block.timestamp,
            expiresAt: deadline,
            signature: EgressExecutor.Signature({v: 27, r: bytes32(0), s: bytes32(0)})
        });
        bytes32 digest = egress.riskAttestationDigest(attestation);
        (attestation.signature.v, attestation.signature.r, attestation.signature.s) = vm.sign(ATTESTOR_KEY, digest);
    }

    function _signPolicy(EgressExecutor.ProtectionPolicy memory policy, uint256 key)
        internal
        view
        returns (EgressExecutor.Signature memory signature)
    {
        (signature.v, signature.r, signature.s) = vm.sign(key, egress.protectionPolicyDigest(policy));
    }

    function _signPermit(uint256 amount, uint256 deadline)
        internal
        view
        returns (EgressExecutor.PermitData memory permitData)
    {
        bytes32 structHash = keccak256(
            abi.encode(aXbEth.PERMIT_TYPEHASH(), borrower, address(egress), amount, aXbEth.nonces(borrower), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", aXbEth.DOMAIN_SEPARATOR(), structHash));
        (permitData.v, permitData.r, permitData.s) = vm.sign(BORROWER_KEY, digest);
        permitData.deadline = deadline;
    }

    function _healthFactor(address user) internal view returns (uint256) {
        (,,,,, uint256 healthFactor) = pool.getUserAccountData(user);
        return healthFactor;
    }
}
