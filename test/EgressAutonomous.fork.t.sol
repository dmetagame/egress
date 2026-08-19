// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {XLayerForkBase, IAavePoolFixture} from "./helpers/XLayerForkBase.sol";
import {EgressExecutor} from "../src/EgressExecutor.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IATokenPermit} from "../src/interfaces/IATokenPermit.sol";

contract EgressAutonomousForkTest is XLayerForkBase {
    uint256 internal constant RISK_ATTESTOR_KEY = 0xE66158;
    uint256 internal constant COLLATERAL = 50 ether;
    uint256 internal constant DEBT = 44.05 ether;
    uint256 internal constant REPAY = 10_815_264_055_315_765_101;
    uint256 internal constant SELL = 10_803_442_973_837_207_898;

    address internal riskAttestor;

    function setUp() public override {
        super.setUp();
        riskAttestor = vm.addr(RISK_ATTESTOR_KEY);
        _createPosition(COLLATERAL, DEBT);
    }

    function testUserSignsPolicyOnceThenKeeperExecutesWithoutPostEventSignature() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(1, 2, 1 hours);
        bytes32 policyId = _register(policy);
        uint256 permitNonceAfterRegistration = IATokenPermit(AXBETH).nonces(borrower);
        uint256 quote = _quote(SELL);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("material-redemption-change"), REPAY, SELL, quote, 0, RISK_ATTESTOR_KEY);

        uint256 debtBefore = IERC20(VDEBT_XETH).balanceOf(borrower);
        uint256 collateralBefore = IERC20(AXBETH).balanceOf(borrower);
        uint256 healthBefore = _healthFactor(borrower);

        _executeAutonomous(request);

        uint256 debtAfter = IERC20(VDEBT_XETH).balanceOf(borrower);
        uint256 collateralAfter = IERC20(AXBETH).balanceOf(borrower);
        uint256 healthAfter = _healthFactor(borrower);
        (
            address stateUser,
            bool active,
            uint256 executionCount,,
            uint256 cumulativeRepayment,
            uint256 cumulativeCollateral,,
        ) = egress.policyStates(policyId);

        assertEq(stateUser, borrower, "policy user");
        assertTrue(active, "policy remains active");
        assertEq(executionCount, 1, "one autonomous execution");
        assertEq(cumulativeRepayment, REPAY, "repayment budget consumed");
        assertEq(cumulativeCollateral, SELL, "collateral budget consumed");
        assertApproxEqAbs(debtBefore - debtAfter, REPAY, 1, "debt repaid within Aave rounding tolerance");
        assertEq(collateralBefore - collateralAfter, SELL, "collateral sold");
        assertGt(healthAfter, healthBefore, "health factor improves");
        assertGe(healthAfter, policy.minPostHealthFactor, "policy health floor");
        assertEq(
            IATokenPermit(AXBETH).nonces(borrower),
            permitNonceAfterRegistration,
            "no post-event permit or user signature is consumed"
        );
        assertEq(IERC20(AXBETH).balanceOf(address(egress)), 0, "no collateral custody");
        assertEq(IERC20(XBETH).balanceOf(address(egress)), 0, "no underlying custody");
        assertEq(IERC20(XETH).balanceOf(address(egress)), 0, "no debt-asset custody");
    }

    function testUserCanRevokePolicyOnchain() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(2, 1, 0);
        bytes32 policyId = _register(policy);
        vm.prank(borrower);
        egress.revokeProtectionPolicy(policyId);

        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("revoked"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.PolicyInactive.selector);
        egress.executeAutonomous(request);
    }

    function testGlobalRevocationEpochInvalidatesPolicy() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(3, 1, 0);
        _register(policy);
        vm.prank(borrower);
        egress.revokeAuthorizations();

        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("epoch-revoked"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.PolicyRevoked.selector);
        egress.executeAutonomous(request);
    }

    function testMaliciousKeeperCannotIncreaseRepayment() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(4, 1, 0);
        _register(policy);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("repay-overflow"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        request.execution.repayAmount = policy.maxRepaymentPerExecution + 1;

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.RepaymentExceedsMaximum.selector);
        egress.executeAutonomous(request);
    }

    function testMaliciousKeeperCannotIncreaseCollateral() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(5, 1, 0);
        _register(policy);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("collateral-overflow"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        request.execution.collateralAmount = policy.maxCollateralPerExecution + 1;

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.CollateralExceedsMaximum.selector);
        egress.executeAutonomous(request);
    }

    function testMaliciousKeeperCannotLowerQuoteBelowOracleBound() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(22, 1, 0);
        _register(policy);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("manipulated-quote"), 1 ether, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        request.execution.expectedSwapOut = 1.001 ether;
        request.execution.minSwapOut = 1.001 ether;

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.SwapOutputBelowOracleFloor.selector);
        egress.executeAutonomous(request);
    }

    function testMaliciousKeeperCannotWidenSlippage() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(23, 1, 0);
        _register(policy);
        uint256 quote = _quote(1 ether);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("widened-slippage"), 1 ether, 1 ether, quote, 0, RISK_ATTESTOR_KEY);
        request.execution.expectedSwapOut = quote + 1 ether;

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.SwapOutputBelowSlippageFloor.selector);
        egress.executeAutonomous(request);
    }

    function testReducedCollateralAllowanceFailsClosed() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(24, 1, 0);
        _register(policy);
        vm.prank(borrower);
        IERC20(AXBETH).approve(address(egress), SELL - 1);

        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("reduced-allowance"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.InsufficientCollateralAllowance.selector);
        egress.executeAutonomous(request);
    }

    function testKeeperCannotSubstituteAnotherPositionUser() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(25, 1, 0);
        _register(policy);
        policy.user = attacker;

        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("substituted-position"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.PolicyNotRegistered.selector);
        egress.executeAutonomous(request);
    }

    function testWrongKeeperCannotExecute() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(6, 1, 0);
        _register(policy);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("wrong-keeper"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);

        vm.prank(attacker);
        vm.expectPartialRevert(EgressExecutor.UnauthorizedKeeper.selector);
        egress.executeAutonomous(request);
    }

    function testPolicyMutationRequiresFreshUserAuthorization() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(7, 1, 0);
        _register(policy);
        policy.maxSlippageBps += 1;
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("mutated-policy"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.PolicyNotRegistered.selector);
        egress.executeAutonomous(request);
    }

    function testWrongProtocolConfigurationCannotBeRegistered() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(8, 1, 0);
        policy.protocolConfigHash = keccak256("attacker-protocol");
        EgressExecutor.Signature memory signature = _signPolicy(policy, BORROWER_KEY);
        EgressExecutor.PermitData memory permit =
            _signPermit(policy.maxCumulativeCollateral, policy.expiresAt, BORROWER_KEY);

        vm.prank(keeper);
        vm.expectRevert(EgressExecutor.InvalidProtectionPolicy.selector);
        egress.registerProtectionPolicy(policy, signature, permit);
    }

    function testInvalidPolicySignerCannotRegister() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(9, 1, 0);
        EgressExecutor.Signature memory signature = _signPolicy(policy, ATTACKER_KEY);
        EgressExecutor.PermitData memory permit =
            _signPermit(policy.maxCumulativeCollateral, policy.expiresAt, BORROWER_KEY);

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.InvalidPolicySigner.selector);
        egress.registerProtectionPolicy(policy, signature, permit);
    }

    function testPolicyNonceCannotBeReused() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(10, 1, 0);
        _register(policy);
        EgressExecutor.Signature memory signature = _signPolicy(policy, BORROWER_KEY);
        EgressExecutor.PermitData memory noPermit =
            EgressExecutor.PermitData({deadline: policy.expiresAt, v: 27, r: bytes32(0), s: bytes32(0)});

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.PolicyNonceAlreadyUsed.selector);
        egress.registerProtectionPolicy(policy, signature, noPermit);
    }

    function testExpiredPolicyCannotExecute() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(11, 1, 0);
        _register(policy);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("expired-policy"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        vm.warp(policy.expiresAt + 1);

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.PolicyExpired.selector);
        egress.executeAutonomous(request);
    }

    function testExecutionNonceCannotBeSkippedOrReplayed() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(12, 2, 0);
        _register(policy);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("wrong-nonce"), REPAY, SELL, _quote(SELL), 1, RISK_ATTESTOR_KEY);

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.ExecutionNonceMismatch.selector);
        egress.executeAutonomous(request);
    }

    function testRiskBelowThresholdCannotExecute() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(13, 1, 0);
        _register(policy);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("medium-risk"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        request.riskAttestation = _attestation(
            policy,
            request.riskAttestation.riskEventId,
            2,
            block.timestamp,
            block.timestamp + 5 minutes,
            RISK_ATTESTOR_KEY
        );

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.RiskBelowPolicyThreshold.selector);
        egress.executeAutonomous(request);
    }

    function testCompromisedAttestorCannotEscapePolicyBounds() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(14, 1, 0);
        _register(policy);
        bytes32 fabricatedEvent = keccak256("fabricated-high-risk");
        uint256 quote = _quote(SELL);
        EgressExecutor.AutonomousExecutionRequest memory excessive =
            _request(policy, fabricatedEvent, REPAY, SELL, quote, 0, RISK_ATTESTOR_KEY);
        excessive.execution.repayAmount = policy.maxRepaymentPerExecution + 1;

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.RepaymentExceedsMaximum.selector);
        egress.executeAutonomous(excessive);

        EgressExecutor.AutonomousExecutionRequest memory bounded =
            _request(policy, fabricatedEvent, REPAY, SELL, quote, 0, RISK_ATTESTOR_KEY);
        uint256 healthBefore = _healthFactor(borrower);
        _executeAutonomous(bounded);
        assertGt(_healthFactor(borrower), healthBefore, "even a false trigger remains bounded and beneficial");
    }

    function testInvalidRiskAttestorCannotExecute() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(15, 1, 0);
        _register(policy);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("forged-attestation"), REPAY, SELL, _quote(SELL), 0, ATTACKER_KEY);

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.InvalidRiskAttestor.selector);
        egress.executeAutonomous(request);
    }

    function testStaleRiskAttestationCannotExecute() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(16, 1, 0);
        _register(policy);
        uint256 issuedAt = block.timestamp - policy.maxRiskAgeSeconds - 1;
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("stale-attestation"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        request.riskAttestation = _attestation(
            policy, request.riskAttestation.riskEventId, 3, issuedAt, block.timestamp + 5 minutes, RISK_ATTESTOR_KEY
        );

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.RiskAttestationStale.selector);
        egress.executeAutonomous(request);
    }

    function testFutureRiskAttestationCannotExecute() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(26, 1, 0);
        _register(policy);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("future-attestation"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        request.riskAttestation = _attestation(
            policy,
            request.riskAttestation.riskEventId,
            3,
            block.timestamp + policy.maxClockSkewSeconds + 1,
            request.execution.deadline,
            RISK_ATTESTOR_KEY
        );

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.RiskAttestationFromFuture.selector);
        egress.executeAutonomous(request);
    }

    function testExpiredRiskAttestationCannotExecute() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(27, 1, 0);
        _register(policy);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("expired-attestation"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        request.riskAttestation = _attestation(
            policy, request.riskAttestation.riskEventId, 3, block.timestamp - 2, block.timestamp - 1, RISK_ATTESTOR_KEY
        );

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.ExecutionDeadlineInvalid.selector);
        egress.executeAutonomous(request);
    }

    function testRiskEventCannotBeReplayed() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(17, 2, 1 hours);
        _register(policy);
        bytes32 eventId = keccak256("one-event-one-execution");
        uint256 quote = _quote(SELL);
        _executeAutonomous(_request(policy, eventId, REPAY, SELL, quote, 0, RISK_ATTESTOR_KEY));
        vm.warp(block.timestamp + policy.cooldownSeconds + 1);

        EgressExecutor.AutonomousExecutionRequest memory replay =
            _request(policy, eventId, 1 ether, 1 ether, _quote(1 ether), 1, RISK_ATTESTOR_KEY);
        replay.execution.deadline = policy.expiresAt - 1;
        replay.riskAttestation = _attestation(policy, eventId, 3, block.timestamp, policy.expiresAt, RISK_ATTESTOR_KEY);
        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.RiskEventAlreadyUsed.selector);
        egress.executeAutonomous(replay);
    }

    function testCooldownBlocksSecondExecution() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(18, 2, 1 hours);
        _register(policy);
        _executeAutonomous(_request(policy, keccak256("first-event"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY));

        EgressExecutor.AutonomousExecutionRequest memory second =
            _request(policy, keccak256("second-event"), 1 ether, 1 ether, _quote(1 ether), 1, RISK_ATTESTOR_KEY);
        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.PolicyCooldownActive.selector);
        egress.executeAutonomous(second);
    }

    function testMaximumExecutionCountIsEnforced() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(19, 1, 0);
        _register(policy);
        _executeAutonomous(_request(policy, keccak256("only-event"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY));

        EgressExecutor.AutonomousExecutionRequest memory second =
            _request(policy, keccak256("blocked-event"), 1 ether, 1 ether, _quote(1 ether), 1, RISK_ATTESTOR_KEY);
        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.PolicyExecutionLimitReached.selector);
        egress.executeAutonomous(second);
    }

    function testCumulativeRepaymentBudgetIsEnforced() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(20, 2, 0);
        policy.maxCumulativeRepayment = 11.5 ether;
        policy.maxCumulativeCollateral = 12.5 ether;
        _register(policy);
        _executeAutonomous(_request(policy, keccak256("budget-one"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY));

        vm.prank(borrower);
        IAavePoolFixture(AAVE_POOL).borrow(XETH, 1.4 ether, 2, 0, borrower);
        assertLe(_healthFactor(borrower), policy.maxPreHealthFactor, "position re-enters trigger range");

        EgressExecutor.AutonomousExecutionRequest memory second =
            _request(policy, keccak256("budget-two"), 1 ether, 1 ether, _quote(1 ether), 1, RISK_ATTESTOR_KEY);
        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.PolicyCumulativeRepaymentExceeded.selector);
        egress.executeAutonomous(second);
    }

    function testCumulativeCollateralBudgetIsEnforced() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(28, 2, 0);
        _register(policy);
        _executeAutonomous(
            _request(policy, keccak256("collateral-budget-one"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY)
        );

        vm.startPrank(borrower);
        IAavePoolFixture(AAVE_POOL).borrow(XETH, 1.4 ether, 2, 0, borrower);
        IERC20(AXBETH).approve(address(egress), type(uint256).max);
        vm.stopPrank();
        assertLe(_healthFactor(borrower), policy.maxPreHealthFactor, "position re-enters trigger range");

        EgressExecutor.AutonomousExecutionRequest memory second = _request(
            policy, keccak256("collateral-budget-two"), 1 ether, 2 ether, _quote(2 ether), 1, RISK_ATTESTOR_KEY
        );
        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.PolicyCumulativeCollateralExceeded.selector);
        egress.executeAutonomous(second);
    }

    function testPositionDebtCeilingRejectsMaterialPositionDrift() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(29, 1, 0);
        policy.maxPositionDebt = IERC20(VDEBT_XETH).balanceOf(borrower);
        _register(policy);
        vm.warp(block.timestamp + 1 days);
        assertGt(IERC20(VDEBT_XETH).balanceOf(borrower), policy.maxPositionDebt, "debt must accrue above ceiling");

        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("position-debt-drift"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);
        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.PositionDebtExceedsPolicy.selector);
        egress.executeAutonomous(request);
    }

    function testUnsafeAutonomousPostHealthFactorRollsBackAllState() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(30, 1, 0);
        bytes32 policyId = _register(policy);
        bytes32 riskEventId = keccak256("unsafe-post-health-factor");
        uint256 debtBefore = IERC20(VDEBT_XETH).balanceOf(borrower);
        uint256 collateralBefore = IERC20(AXBETH).balanceOf(borrower);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, riskEventId, 1 ether, 1 ether, _quote(1 ether), 0, RISK_ATTESTOR_KEY);

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.UnsafePostHealthFactor.selector);
        egress.executeAutonomous(request);

        assertEq(IERC20(VDEBT_XETH).balanceOf(borrower), debtBefore, "debt rolls back");
        assertEq(IERC20(AXBETH).balanceOf(borrower), collateralBefore, "collateral rolls back");
        (,, uint256 executionCount,, uint256 cumulativeRepayment, uint256 cumulativeCollateral,,) =
            egress.policyStates(policyId);
        assertEq(executionCount, 0, "execution count rolls back");
        assertEq(cumulativeRepayment, 0, "repayment counter rolls back");
        assertEq(cumulativeCollateral, 0, "collateral counter rolls back");
        assertFalse(egress.riskEventUsed(policyId, riskEventId), "risk event remains unused after rollback");
    }

    function testCollateralPercentageCapIsEnforcedAtRegistration() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(31, 1, 0);
        policy.maxCollateralPercentageBps = 2_000;
        EgressExecutor.Signature memory policySignature = _signPolicy(policy, BORROWER_KEY);
        EgressExecutor.PermitData memory collateralPermit =
            _signPermit(policy.maxCumulativeCollateral, policy.expiresAt, BORROWER_KEY);

        vm.prank(keeper);
        vm.expectRevert(EgressExecutor.InvalidProtectionPolicy.selector);
        egress.registerProtectionPolicy(policy, policySignature, collateralPermit);
    }

    function testAutonomousFlashPremiumCeilingRollsBackAtomically() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(32, 1, 0);
        policy.maxFlashLoanPremiumBps = 4;
        bytes32 policyId = _register(policy);
        bytes32 riskEventId = keccak256("flash-premium-ceiling");
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, riskEventId, REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);

        vm.prank(keeper);
        vm.expectPartialRevert(EgressExecutor.FlashLoanPremiumExceedsMaximum.selector);
        egress.executeAutonomous(request);

        (,, uint256 executionCount,, uint256 cumulativeRepayment, uint256 cumulativeCollateral,,) =
            egress.policyStates(policyId);
        assertEq(executionCount, 0, "execution count rolls back");
        assertEq(cumulativeRepayment, 0, "repayment counter rolls back");
        assertEq(cumulativeCollateral, 0, "collateral counter rolls back");
        assertFalse(egress.riskEventUsed(policyId, riskEventId), "risk event remains unused after rollback");
    }

    function testEmergencyPauseStopsAutonomousExecution() external {
        EgressExecutor.ProtectionPolicy memory policy = _policy(21, 1, 0);
        _register(policy);
        egress.setPaused(true);
        EgressExecutor.AutonomousExecutionRequest memory request =
            _request(policy, keccak256("paused"), REPAY, SELL, _quote(SELL), 0, RISK_ATTESTOR_KEY);

        vm.prank(keeper);
        vm.expectRevert(EgressExecutor.Paused.selector);
        egress.executeAutonomous(request);
    }

    function _policy(uint256 nonce, uint256 maximumExecutions, uint256 cooldown)
        internal
        view
        returns (EgressExecutor.ProtectionPolicy memory policy)
    {
        policy = EgressExecutor.ProtectionPolicy({
            user: borrower,
            keeper: keeper,
            riskAttestor: riskAttestor,
            protocolConfigHash: egress.PROTOCOL_CONFIG_HASH(),
            minimumRiskLevel: 3,
            maxRepaymentPerExecution: REPAY,
            maxCollateralPerExecution: SELL,
            maxCumulativeRepayment: REPAY * 2,
            maxCumulativeCollateral: 12.5 ether,
            maxCollateralPercentageBps: 2_500,
            maxPositionDebt: 46 ether,
            maxSlippageBps: 100,
            maxOracleDeviationBps: 125,
            maxFlashLoanPremiumBps: MAX_FLASH_LOAN_PREMIUM_BPS,
            maxPreHealthFactor: 1.04 ether,
            minPostHealthFactor: 1.07 ether,
            cooldownSeconds: cooldown,
            maxExecutions: maximumExecutions,
            maxRiskAgeSeconds: 15 minutes,
            maxClockSkewSeconds: 30,
            expiresAt: block.timestamp + 7 days,
            nonce: nonce,
            revocationNonce: egress.revocationNonces(borrower)
        });
    }

    function _register(EgressExecutor.ProtectionPolicy memory policy) internal returns (bytes32 policyId) {
        EgressExecutor.Signature memory policySignature = _signPolicy(policy, BORROWER_KEY);
        EgressExecutor.PermitData memory collateralPermit =
            _signPermit(policy.maxCumulativeCollateral, policy.expiresAt, BORROWER_KEY);
        vm.prank(keeper);
        policyId = egress.registerProtectionPolicy(policy, policySignature, collateralPermit);
    }

    function _request(
        EgressExecutor.ProtectionPolicy memory policy,
        bytes32 riskEventId,
        uint256 repayAmount,
        uint256 collateralAmount,
        uint256 expectedSwapOut,
        uint256 executionNonce,
        uint256 attestorKey
    ) internal view returns (EgressExecutor.AutonomousExecutionRequest memory request) {
        uint256 deadline = block.timestamp + 5 minutes;
        request = EgressExecutor.AutonomousExecutionRequest({
            policy: policy,
            riskAttestation: _attestation(policy, riskEventId, 3, block.timestamp, deadline, attestorKey),
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

    function _attestation(
        EgressExecutor.ProtectionPolicy memory policy,
        bytes32 riskEventId,
        uint8 riskLevel,
        uint256 issuedAt,
        uint256 expiresAt,
        uint256 key
    ) internal view returns (EgressExecutor.RiskAttestation memory attestation) {
        attestation = EgressExecutor.RiskAttestation({
            policyId: egress.protectionPolicyDigest(policy),
            riskEventId: riskEventId,
            verdictHash: keccak256(abi.encode("verdict", riskEventId, riskLevel)),
            evidenceHash: keccak256(abi.encode("evidence", riskEventId)),
            riskLevel: riskLevel,
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            signature: EgressExecutor.Signature({v: 27, r: bytes32(0), s: bytes32(0)})
        });
        bytes32 digest = egress.riskAttestationDigest(attestation);
        (attestation.signature.v, attestation.signature.r, attestation.signature.s) = vm.sign(key, digest);
    }

    function _signPolicy(EgressExecutor.ProtectionPolicy memory policy, uint256 key)
        internal
        view
        returns (EgressExecutor.Signature memory signature)
    {
        bytes32 digest = egress.protectionPolicyDigest(policy);
        (signature.v, signature.r, signature.s) = vm.sign(key, digest);
    }

    function _executeAutonomous(EgressExecutor.AutonomousExecutionRequest memory request) internal {
        vm.prank(keeper);
        egress.executeAutonomous(request);
    }
}
