// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IATokenPermit, IVariableDebtToken} from "./interfaces/IATokenPermit.sol";
import {IAaveOracle, IAavePool, IPoolAddressesProvider} from "./interfaces/IAavePool.sol";
import {ISwapRouter02, IUniswapV3Factory, IUniswapV3Pool} from "./interfaces/IUniswapV3.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";
import {ECDSA} from "./libraries/ECDSA.sol";

/// @notice Single-market, bounded deleveraging executor for xBETH collateral and xETH debt on Aave X Layer.
/// @dev The executor is intentionally non-upgradeable and has no arbitrary-call or arbitrary-token surface.
contract EgressExecutor {
    using SafeTransferLib for address;

    string public constant NAME = "Egress";
    string public constant VERSION = "1";
    uint256 public constant BPS = 10_000;
    uint256 public constant VARIABLE_RATE_MODE = 2;
    uint256 public constant AAVE_DEBT_ROUNDING_TOLERANCE_WEI = 1;
    uint8 public constant RISK_HIGH = 3;
    uint8 public constant RISK_CRITICAL = 4;

    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(address user,address executor,uint256 repayAmount,uint256 collateralAmount,uint256 maxRepayment,uint256 maxCollateral,uint256 expectedSwapOut,uint256 minSwapOut,uint256 maxSlippageBps,uint256 maxFlashLoanPremiumBps,uint256 minPostHealthFactor,uint256 deadline,uint256 nonce,uint256 revocationNonce)"
    );
    bytes32 public constant PROTECTION_POLICY_TYPEHASH = keccak256(
        "ProtectionPolicy(address user,address keeper,address riskAttestor,bytes32 protocolConfigHash,uint8 minimumRiskLevel,uint256 maxRepaymentPerExecution,uint256 maxCollateralPerExecution,uint256 maxCumulativeRepayment,uint256 maxCumulativeCollateral,uint256 maxCollateralPercentageBps,uint256 maxPositionDebt,uint256 maxSlippageBps,uint256 maxOracleDeviationBps,uint256 maxFlashLoanPremiumBps,uint256 maxPreHealthFactor,uint256 minPostHealthFactor,uint256 cooldownSeconds,uint256 maxExecutions,uint256 maxRiskAgeSeconds,uint256 maxClockSkewSeconds,uint256 expiresAt,uint256 nonce,uint256 revocationNonce)"
    );
    bytes32 public constant RISK_ATTESTATION_TYPEHASH = keccak256(
        "RiskAttestation(bytes32 policyId,bytes32 riskEventId,bytes32 verdictHash,bytes32 evidenceHash,uint8 riskLevel,uint256 issuedAt,uint256 expiresAt)"
    );
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    error ZeroAddress();
    error InvalidProtocolConfiguration();
    error Reentrancy();
    error FlashLoanNotActive();
    error NotAavePool(address caller);
    error InvalidFlashInitiator(address initiator);
    error WrongFlashAsset(address asset);
    error WrongFlashAmount(uint256 expected, uint256 actual);
    error Paused();
    error NotGuardian(address caller);
    error AuthorizationExpired(uint256 deadline, uint256 currentTime);
    error InvalidAuthorizationSigner(address recovered, address expected);
    error AuthorizationAlreadyUsed(address user, uint256 nonce);
    error AuthorizationRevoked(uint256 signedRevocationNonce, uint256 currentRevocationNonce);
    error UnauthorizedExecutor(address expected, address actual);
    error InvalidAmount();
    error RepaymentExceedsMaximum(uint256 requested, uint256 maximum);
    error CollateralExceedsMaximum(uint256 requested, uint256 maximum);
    error InvalidSlippageBps(uint256 value);
    error InvalidFlashLoanPremiumBps(uint256 value);
    error FlashLoanPremiumExceedsMaximum(uint256 actual, uint256 maximum);
    error PermitExpiresBeforeAuthorization(uint256 permitDeadline, uint256 authorizationDeadline);
    error InsufficientCollateralAllowance(uint256 actual, uint256 required);
    error SwapOutputBelowAuthorization(uint256 minimum, uint256 authorizedMinimum);
    error SwapOutputBelowSlippageFloor(uint256 minimum, uint256 floor);
    error QuoteBelowSignedMinimum(uint256 quote, uint256 signedMinimum);
    error InsufficientSwapOutput(uint256 actual, uint256 required);
    error UnsafePostHealthFactor(uint256 actual, uint256 minimum);
    error RepayAmountMismatch(uint256 expected, uint256 actual);
    error CollateralAmountMismatch(uint256 expected, uint256 actual);
    error BalanceNotRestored(address token, uint256 expected, uint256 actual);
    error InvalidProtectionPolicy();
    error InvalidPolicySigner(address recovered, address expected);
    error PolicyNonceAlreadyUsed(address user, uint256 nonce);
    error PolicyNotRegistered(bytes32 policyId);
    error PolicyInactive(bytes32 policyId);
    error PolicyExpired(uint256 deadline, uint256 currentTime);
    error PolicyRevoked(uint256 signedRevocationNonce, uint256 currentRevocationNonce);
    error NotPolicyUser(address caller, address user);
    error UnauthorizedKeeper(address expected, address actual);
    error PolicyExecutionLimitReached(uint256 actual, uint256 maximum);
    error PolicyCooldownActive(uint256 nextExecutionAt, uint256 currentTime);
    error PolicyCumulativeRepaymentExceeded(uint256 requested, uint256 maximum);
    error PolicyCumulativeCollateralExceeded(uint256 requested, uint256 maximum);
    error PolicyCollateralPercentageExceeded(uint256 requested, uint256 maximum);
    error PositionDebtExceedsPolicy(uint256 actual, uint256 maximum);
    error PositionHealthFactorAboveTrigger(uint256 actual, uint256 maximum);
    error ExecutionNonceMismatch(uint256 expected, uint256 actual);
    error ExecutionDeadlineInvalid(uint256 deadline, uint256 maximum);
    error RiskAttestationExpired(uint256 deadline, uint256 currentTime);
    error RiskAttestationStale(uint256 issuedAt, uint256 currentTime, uint256 maximumAge);
    error RiskAttestationFromFuture(uint256 issuedAt, uint256 currentTime, uint256 maximumSkew);
    error RiskBelowPolicyThreshold(uint8 actual, uint8 minimum);
    error InvalidRiskAttestor(address recovered, address expected);
    error RiskEventAlreadyUsed(bytes32 policyId, bytes32 riskEventId);
    error SwapOutputBelowOracleFloor(uint256 minimum, uint256 floor);
    error OraclePriceUnavailable(address asset);

    struct ProtocolConfig {
        address pool;
        address poolAddressesProvider;
        address aaveOracle;
        address xeth;
        address xbEth;
        address aXbEth;
        address variableDebtXeth;
        address uniswapFactory;
        address swapRouter;
        address swapPool;
        uint24 poolFee;
    }

    struct Authorization {
        address user;
        address executor;
        uint256 repayAmount;
        uint256 collateralAmount;
        uint256 maxRepayment;
        uint256 maxCollateral;
        uint256 expectedSwapOut;
        uint256 minSwapOut;
        uint256 maxSlippageBps;
        uint256 maxFlashLoanPremiumBps;
        uint256 minPostHealthFactor;
        uint256 deadline;
        uint256 nonce;
        uint256 revocationNonce;
    }

    struct Signature {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct PermitData {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct ExecutionRequest {
        Authorization authorization;
        Signature authorizationSignature;
        PermitData collateralPermit;
    }

    struct ProtectionPolicy {
        address user;
        address keeper;
        address riskAttestor;
        bytes32 protocolConfigHash;
        uint8 minimumRiskLevel;
        uint256 maxRepaymentPerExecution;
        uint256 maxCollateralPerExecution;
        uint256 maxCumulativeRepayment;
        uint256 maxCumulativeCollateral;
        uint256 maxCollateralPercentageBps;
        uint256 maxPositionDebt;
        uint256 maxSlippageBps;
        uint256 maxOracleDeviationBps;
        uint256 maxFlashLoanPremiumBps;
        uint256 maxPreHealthFactor;
        uint256 minPostHealthFactor;
        uint256 cooldownSeconds;
        uint256 maxExecutions;
        uint256 maxRiskAgeSeconds;
        uint256 maxClockSkewSeconds;
        uint256 expiresAt;
        uint256 nonce;
        uint256 revocationNonce;
    }

    struct RiskAttestation {
        bytes32 policyId;
        bytes32 riskEventId;
        bytes32 verdictHash;
        bytes32 evidenceHash;
        uint8 riskLevel;
        uint256 issuedAt;
        uint256 expiresAt;
        Signature signature;
    }

    struct AutonomousExecution {
        uint256 repayAmount;
        uint256 collateralAmount;
        uint256 expectedSwapOut;
        uint256 minSwapOut;
        uint256 deadline;
        uint256 executionNonce;
    }

    struct AutonomousExecutionRequest {
        ProtectionPolicy policy;
        RiskAttestation riskAttestation;
        AutonomousExecution execution;
    }

    struct PolicyState {
        address user;
        bool active;
        uint256 executionCount;
        uint256 lastExecutionAt;
        uint256 cumulativeRepayment;
        uint256 cumulativeCollateral;
        uint256 enrollmentCollateral;
        uint256 enrollmentDebt;
    }

    struct CallbackData {
        address user;
        uint256 collateralAmount;
        uint256 minSwapOut;
        uint256 minPostHealthFactor;
        uint256 maxFlashLoanPremiumBps;
        uint256 debtBefore;
        uint256 collateralBefore;
        uint256 nonce;
        bytes32 authorizationHash;
    }

    struct ActiveExecution {
        address user;
        address executor;
        uint256 repayAmount;
        uint256 collateralAmount;
        uint256 minSwapOut;
        uint256 minPostHealthFactor;
        uint256 maxFlashLoanPremiumBps;
        uint256 debtBefore;
        uint256 collateralBefore;
        uint256 nonce;
        bytes32 authorizationHash;
    }

    IAavePool public immutable AAVE_POOL;
    IATokenPermit public immutable A_XBETH;
    ISwapRouter02 public immutable SWAP_ROUTER;
    address public immutable POOL_ADDRESSES_PROVIDER;
    address public immutable AAVE_ORACLE;
    address public immutable XETH;
    address public immutable XBETH;
    address public immutable VARIABLE_DEBT_XETH;
    address public immutable UNISWAP_FACTORY;
    address public immutable SWAP_POOL;
    address public immutable GUARDIAN;
    uint24 public immutable POOL_FEE;
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public immutable RISK_DOMAIN_SEPARATOR;
    bytes32 public immutable PROTOCOL_CONFIG_HASH;

    mapping(address user => mapping(uint256 nonce => bool used)) public authorizationUsed;
    mapping(address user => uint256 revocationNonce) public revocationNonces;
    mapping(address user => mapping(uint256 nonce => bool used)) public policyNonceUsed;
    mapping(bytes32 policyId => PolicyState state) public policyStates;
    mapping(bytes32 policyId => mapping(bytes32 riskEventId => bool used)) public riskEventUsed;

    ActiveExecution private _active;
    uint256 private _entered;
    bool public paused;

    event AuthorizationsRevoked(address indexed user, uint256 newRevocationNonce);
    event PauseSet(bool paused);
    event ProtectionPolicyRegistered(
        bytes32 indexed policyId,
        address indexed user,
        address indexed keeper,
        address riskAttestor,
        uint256 expiresAt,
        uint256 maximumExecutions,
        uint256 collateralBudget
    );
    event ProtectionPolicyRevoked(bytes32 indexed policyId, address indexed user);
    event AutonomousExecutionAccepted(
        bytes32 indexed policyId,
        bytes32 indexed riskEventId,
        uint256 indexed executionNonce,
        uint256 repayAmount,
        uint256 collateralAmount,
        uint8 riskLevel
    );
    event Deleveraged(
        address indexed user,
        address indexed executor,
        uint256 indexed nonce,
        bytes32 authorizationHash,
        uint256 debtRepaid,
        uint256 collateralSold,
        uint256 swapOutput,
        uint256 flashPremium,
        uint256 surplusReturned,
        uint256 healthFactorBefore,
        uint256 healthFactorAfter
    );

    constructor(ProtocolConfig memory config) {
        if (
            config.pool == address(0) || config.poolAddressesProvider == address(0) || config.aaveOracle == address(0)
                || config.xeth == address(0) || config.xbEth == address(0) || config.aXbEth == address(0)
                || config.variableDebtXeth == address(0) || config.uniswapFactory == address(0)
                || config.swapRouter == address(0) || config.swapPool == address(0)
        ) revert ZeroAddress();

        if (
            IAavePool(config.pool).ADDRESSES_PROVIDER() != config.poolAddressesProvider
                || IPoolAddressesProvider(config.poolAddressesProvider).getPool() != config.pool
                || IPoolAddressesProvider(config.poolAddressesProvider).getPriceOracle() != config.aaveOracle
                || IATokenPermit(config.aXbEth).POOL() != config.pool
                || IATokenPermit(config.aXbEth).UNDERLYING_ASSET_ADDRESS() != config.xbEth
                || IVariableDebtToken(config.variableDebtXeth).POOL() != config.pool
                || IVariableDebtToken(config.variableDebtXeth).UNDERLYING_ASSET_ADDRESS() != config.xeth
                || ISwapRouter02(config.swapRouter).factory() != config.uniswapFactory
                || IUniswapV3Pool(config.swapPool).factory() != config.uniswapFactory
                || IUniswapV3Pool(config.swapPool).token0() != config.xbEth
                || IUniswapV3Pool(config.swapPool).token1() != config.xeth
                || IUniswapV3Pool(config.swapPool).fee() != config.poolFee
                || IUniswapV3Factory(config.uniswapFactory).getPool(config.xbEth, config.xeth, config.poolFee)
                    != config.swapPool
        ) revert InvalidProtocolConfiguration();

        AAVE_POOL = IAavePool(config.pool);
        POOL_ADDRESSES_PROVIDER = config.poolAddressesProvider;
        AAVE_ORACLE = config.aaveOracle;
        XETH = config.xeth;
        XBETH = config.xbEth;
        A_XBETH = IATokenPermit(config.aXbEth);
        VARIABLE_DEBT_XETH = config.variableDebtXeth;
        UNISWAP_FACTORY = config.uniswapFactory;
        SWAP_ROUTER = ISwapRouter02(config.swapRouter);
        SWAP_POOL = config.swapPool;
        POOL_FEE = config.poolFee;
        GUARDIAN = msg.sender;

        PROTOCOL_CONFIG_HASH = keccak256(
            abi.encode(
                config.pool,
                config.poolAddressesProvider,
                config.aaveOracle,
                config.xeth,
                config.xbEth,
                config.aXbEth,
                config.variableDebtXeth,
                config.uniswapFactory,
                config.swapRouter,
                config.swapPool,
                config.poolFee
            )
        );

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)), block.chainid, address(this)
            )
        );
        RISK_DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH,
                keccak256(bytes("Egress Risk Attestor")),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    modifier nonReentrant() {
        if (_entered != 0) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    function setPaused(bool value) external {
        if (msg.sender != GUARDIAN) revert NotGuardian(msg.sender);
        paused = value;
        emit PauseSet(value);
    }

    function revokeAuthorizations() external returns (uint256 newRevocationNonce) {
        newRevocationNonce = ++revocationNonces[msg.sender];
        emit AuthorizationsRevoked(msg.sender, newRevocationNonce);
    }

    function authorizationDigest(Authorization calldata authorization) external view returns (bytes32) {
        return _authorizationDigest(authorization);
    }

    function protectionPolicyDigest(ProtectionPolicy calldata policy) external view returns (bytes32) {
        return _protectionPolicyDigest(policy);
    }

    function riskAttestationDigest(RiskAttestation calldata attestation) external view returns (bytes32) {
        return _riskAttestationDigest(attestation);
    }

    function registerProtectionPolicy(
        ProtectionPolicy calldata policy,
        Signature calldata policySignature,
        PermitData calldata collateralPermit
    ) external nonReentrant whenNotPaused returns (bytes32 policyId) {
        policyId = _validateProtectionPolicy(policy, policySignature);
        if (policyNonceUsed[policy.user][policy.nonce]) {
            revert PolicyNonceAlreadyUsed(policy.user, policy.nonce);
        }

        uint256 collateral = A_XBETH.balanceOf(policy.user);
        uint256 debt = _balanceOf(VARIABLE_DEBT_XETH, policy.user);
        uint256 percentageBudget = collateral * policy.maxCollateralPercentageBps / BPS;
        if (policy.maxCumulativeCollateral > percentageBudget || debt > policy.maxPositionDebt) {
            revert InvalidProtectionPolicy();
        }
        if (collateralPermit.deadline < policy.expiresAt) {
            revert PermitExpiresBeforeAuthorization(collateralPermit.deadline, policy.expiresAt);
        }

        uint256 collateralAllowance = A_XBETH.allowance(policy.user, address(this));
        if (collateralAllowance < policy.maxCumulativeCollateral) {
            A_XBETH.permit(
                policy.user,
                address(this),
                policy.maxCumulativeCollateral,
                collateralPermit.deadline,
                collateralPermit.v,
                collateralPermit.r,
                collateralPermit.s
            );
            collateralAllowance = A_XBETH.allowance(policy.user, address(this));
            if (collateralAllowance < policy.maxCumulativeCollateral) {
                revert InsufficientCollateralAllowance(collateralAllowance, policy.maxCumulativeCollateral);
            }
        }

        policyNonceUsed[policy.user][policy.nonce] = true;
        policyStates[policyId] = PolicyState({
            user: policy.user,
            active: true,
            executionCount: 0,
            lastExecutionAt: 0,
            cumulativeRepayment: 0,
            cumulativeCollateral: 0,
            enrollmentCollateral: collateral,
            enrollmentDebt: debt
        });

        emit ProtectionPolicyRegistered(
            policyId,
            policy.user,
            policy.keeper,
            policy.riskAttestor,
            policy.expiresAt,
            policy.maxExecutions,
            policy.maxCumulativeCollateral
        );
    }

    function revokeProtectionPolicy(bytes32 policyId) external {
        PolicyState storage state = policyStates[policyId];
        if (state.user == address(0)) revert PolicyNotRegistered(policyId);
        if (msg.sender != state.user) revert NotPolicyUser(msg.sender, state.user);
        state.active = false;
        emit ProtectionPolicyRevoked(policyId, msg.sender);
    }

    function isProtectionPolicyActive(bytes32 policyId, ProtectionPolicy calldata policy) external view returns (bool) {
        PolicyState storage state = policyStates[policyId];
        return state.user != address(0) && state.active && policyId == _protectionPolicyDigest(policy)
            && state.user == policy.user && policy.revocationNonce == revocationNonces[policy.user]
            && block.timestamp <= policy.expiresAt && state.executionCount < policy.maxExecutions;
    }

    function execute(ExecutionRequest calldata request) external nonReentrant whenNotPaused {
        Authorization calldata authorization = request.authorization;
        _validateAuthorization(authorization, request.authorizationSignature);
        if (request.collateralPermit.deadline < authorization.deadline) {
            revert PermitExpiresBeforeAuthorization(request.collateralPermit.deadline, authorization.deadline);
        }

        bytes32 digest = _authorizationDigest(authorization);
        authorizationUsed[authorization.user][authorization.nonce] = true;

        uint256 collateralAllowance = A_XBETH.allowance(authorization.user, address(this));
        if (collateralAllowance < authorization.collateralAmount) {
            A_XBETH.permit(
                authorization.user,
                address(this),
                authorization.collateralAmount,
                request.collateralPermit.deadline,
                request.collateralPermit.v,
                request.collateralPermit.r,
                request.collateralPermit.s
            );
            collateralAllowance = A_XBETH.allowance(authorization.user, address(this));
            if (collateralAllowance < authorization.collateralAmount) {
                revert InsufficientCollateralAllowance(collateralAllowance, authorization.collateralAmount);
            }
        }

        uint256 debtBefore = _balanceOf(VARIABLE_DEBT_XETH, authorization.user);
        uint256 collateralBefore = A_XBETH.balanceOf(authorization.user);
        if (authorization.repayAmount > debtBefore) {
            revert RepaymentExceedsMaximum(authorization.repayAmount, debtBefore);
        }
        if (authorization.collateralAmount > collateralBefore) {
            revert CollateralExceedsMaximum(authorization.collateralAmount, collateralBefore);
        }

        _runFlashLoan(
            ActiveExecution({
                user: authorization.user,
                executor: msg.sender,
                repayAmount: authorization.repayAmount,
                collateralAmount: authorization.collateralAmount,
                minSwapOut: authorization.minSwapOut,
                minPostHealthFactor: authorization.minPostHealthFactor,
                maxFlashLoanPremiumBps: authorization.maxFlashLoanPremiumBps,
                debtBefore: debtBefore,
                collateralBefore: collateralBefore,
                nonce: authorization.nonce,
                authorizationHash: digest
            })
        );
    }

    function executeAutonomous(AutonomousExecutionRequest calldata request) external nonReentrant whenNotPaused {
        ProtectionPolicy calldata policy = request.policy;
        RiskAttestation calldata attestation = request.riskAttestation;
        AutonomousExecution calldata execution = request.execution;
        bytes32 policyId = _protectionPolicyDigest(policy);
        PolicyState storage state = policyStates[policyId];
        if (state.user == address(0)) revert PolicyNotRegistered(policyId);
        if (!state.active) revert PolicyInactive(policyId);
        if (state.user != policy.user) revert InvalidProtectionPolicy();
        if (msg.sender != policy.keeper) revert UnauthorizedKeeper(policy.keeper, msg.sender);
        if (policy.revocationNonce != revocationNonces[policy.user]) {
            revert PolicyRevoked(policy.revocationNonce, revocationNonces[policy.user]);
        }
        if (block.timestamp > policy.expiresAt) revert PolicyExpired(policy.expiresAt, block.timestamp);
        if (state.executionCount >= policy.maxExecutions) {
            revert PolicyExecutionLimitReached(state.executionCount, policy.maxExecutions);
        }
        if (state.lastExecutionAt != 0 && block.timestamp < state.lastExecutionAt + policy.cooldownSeconds) {
            revert PolicyCooldownActive(state.lastExecutionAt + policy.cooldownSeconds, block.timestamp);
        }
        if (execution.executionNonce != state.executionCount) {
            revert ExecutionNonceMismatch(state.executionCount, execution.executionNonce);
        }
        if (execution.deadline > policy.expiresAt || execution.deadline > attestation.expiresAt) {
            revert ExecutionDeadlineInvalid(
                execution.deadline, policy.expiresAt < attestation.expiresAt ? policy.expiresAt : attestation.expiresAt
            );
        }
        if (block.timestamp > execution.deadline) revert AuthorizationExpired(execution.deadline, block.timestamp);

        _validateRiskAttestation(policyId, policy, attestation);
        if (riskEventUsed[policyId][attestation.riskEventId]) {
            revert RiskEventAlreadyUsed(policyId, attestation.riskEventId);
        }
        _validateAutonomousExecution(policy, state, execution);

        uint256 debtBefore = _balanceOf(VARIABLE_DEBT_XETH, policy.user);
        uint256 collateralBefore = A_XBETH.balanceOf(policy.user);
        uint256 healthFactorBefore = _healthFactor(policy.user);
        if (debtBefore > policy.maxPositionDebt) {
            revert PositionDebtExceedsPolicy(debtBefore, policy.maxPositionDebt);
        }
        if (healthFactorBefore > policy.maxPreHealthFactor) {
            revert PositionHealthFactorAboveTrigger(healthFactorBefore, policy.maxPreHealthFactor);
        }
        if (execution.repayAmount > debtBefore) revert RepaymentExceedsMaximum(execution.repayAmount, debtBefore);
        if (execution.collateralAmount > collateralBefore) {
            revert CollateralExceedsMaximum(execution.collateralAmount, collateralBefore);
        }
        uint256 collateralAllowance = A_XBETH.allowance(policy.user, address(this));
        if (collateralAllowance < execution.collateralAmount) {
            revert InsufficientCollateralAllowance(collateralAllowance, execution.collateralAmount);
        }

        uint256 cumulativeRepayment = state.cumulativeRepayment + execution.repayAmount;
        if (cumulativeRepayment > policy.maxCumulativeRepayment) {
            revert PolicyCumulativeRepaymentExceeded(cumulativeRepayment, policy.maxCumulativeRepayment);
        }
        uint256 cumulativeCollateral = state.cumulativeCollateral + execution.collateralAmount;
        if (cumulativeCollateral > policy.maxCumulativeCollateral) {
            revert PolicyCumulativeCollateralExceeded(cumulativeCollateral, policy.maxCumulativeCollateral);
        }
        uint256 percentageBudget = state.enrollmentCollateral * policy.maxCollateralPercentageBps / BPS;
        if (cumulativeCollateral > percentageBudget) {
            revert PolicyCollateralPercentageExceeded(cumulativeCollateral, percentageBudget);
        }

        riskEventUsed[policyId][attestation.riskEventId] = true;
        state.executionCount += 1;
        state.lastExecutionAt = block.timestamp;
        state.cumulativeRepayment = cumulativeRepayment;
        state.cumulativeCollateral = cumulativeCollateral;

        bytes32 executionHash = keccak256(
            abi.encode(
                policyId,
                attestation.riskEventId,
                execution.repayAmount,
                execution.collateralAmount,
                execution.expectedSwapOut,
                execution.minSwapOut,
                execution.deadline,
                execution.executionNonce
            )
        );
        emit AutonomousExecutionAccepted(
            policyId,
            attestation.riskEventId,
            execution.executionNonce,
            execution.repayAmount,
            execution.collateralAmount,
            attestation.riskLevel
        );

        _runFlashLoan(
            ActiveExecution({
                user: policy.user,
                executor: msg.sender,
                repayAmount: execution.repayAmount,
                collateralAmount: execution.collateralAmount,
                minSwapOut: execution.minSwapOut,
                minPostHealthFactor: policy.minPostHealthFactor,
                maxFlashLoanPremiumBps: policy.maxFlashLoanPremiumBps,
                debtBefore: debtBefore,
                collateralBefore: collateralBefore,
                nonce: execution.executionNonce,
                authorizationHash: executionHash
            })
        );
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        if (_entered != 1 || _active.user == address(0)) revert FlashLoanNotActive();
        if (msg.sender != address(AAVE_POOL)) revert NotAavePool(msg.sender);
        if (initiator != address(this)) revert InvalidFlashInitiator(initiator);
        if (asset != XETH) revert WrongFlashAsset(asset);
        if (amount != _active.repayAmount) revert WrongFlashAmount(_active.repayAmount, amount);
        uint256 maximumPremium = _percentMulUp(amount, _active.maxFlashLoanPremiumBps);
        if (premium > maximumPremium) revert FlashLoanPremiumExceedsMaximum(premium, maximumPremium);

        CallbackData memory callback = abi.decode(params, (CallbackData));
        if (
            callback.user != _active.user || callback.collateralAmount != _active.collateralAmount
                || callback.minSwapOut != _active.minSwapOut
                || callback.minPostHealthFactor != _active.minPostHealthFactor
                || callback.maxFlashLoanPremiumBps != _active.maxFlashLoanPremiumBps
                || callback.debtBefore != _active.debtBefore || callback.collateralBefore != _active.collateralBefore
                || callback.nonce != _active.nonce || callback.authorizationHash != _active.authorizationHash
        ) revert InvalidProtocolConfiguration();

        uint256 healthFactorBefore = _healthFactor(callback.user);

        XETH.forceApprove(address(AAVE_POOL), amount);
        uint256 repaid = AAVE_POOL.repay(XETH, amount, VARIABLE_RATE_MODE, callback.user);
        if (repaid != amount) revert RepayAmountMismatch(amount, repaid);

        address(A_XBETH).safeTransferFrom(callback.user, address(this), callback.collateralAmount);
        uint256 withdrawn = AAVE_POOL.withdraw(XBETH, callback.collateralAmount, address(this));
        if (withdrawn != callback.collateralAmount) {
            revert CollateralAmountMismatch(callback.collateralAmount, withdrawn);
        }

        XBETH.forceApprove(address(SWAP_ROUTER), callback.collateralAmount);
        uint256 swapOutput = SWAP_ROUTER.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: XBETH,
                tokenOut: XETH,
                fee: POOL_FEE,
                recipient: address(this),
                amountIn: callback.collateralAmount,
                amountOutMinimum: callback.minSwapOut,
                sqrtPriceLimitX96: 0
            })
        );
        XBETH.forceApprove(address(SWAP_ROUTER), 0);

        uint256 healthFactorAfter = _healthFactor(callback.user);
        if (healthFactorAfter < callback.minPostHealthFactor) {
            revert UnsafePostHealthFactor(healthFactorAfter, callback.minPostHealthFactor);
        }

        uint256 debtAfter = _balanceOf(VARIABLE_DEBT_XETH, callback.user);
        uint256 collateralAfter = A_XBETH.balanceOf(callback.user);
        uint256 debtReduction = callback.debtBefore >= debtAfter ? callback.debtBefore - debtAfter : 0;
        if (_absoluteDifference(debtReduction, amount) > AAVE_DEBT_ROUNDING_TOLERANCE_WEI) {
            revert RepayAmountMismatch(amount, debtReduction);
        }
        if (callback.collateralBefore - collateralAfter != callback.collateralAmount) {
            revert CollateralAmountMismatch(callback.collateralAmount, callback.collateralBefore - collateralAfter);
        }

        uint256 owed = amount + premium;
        if (swapOutput < owed) revert InsufficientSwapOutput(swapOutput, owed);

        uint256 surplus = swapOutput - owed;
        if (surplus != 0) XETH.safeTransfer(callback.user, surplus);
        XETH.forceApprove(address(AAVE_POOL), owed);

        emit Deleveraged(
            callback.user,
            _active.executor,
            callback.nonce,
            callback.authorizationHash,
            amount,
            callback.collateralAmount,
            swapOutput,
            premium,
            surplus,
            healthFactorBefore,
            healthFactorAfter
        );

        delete _active;
        return true;
    }

    function _validateAuthorization(Authorization calldata authorization, Signature calldata signature) internal view {
        if (authorization.user == address(0) || authorization.executor == address(0)) revert ZeroAddress();
        if (msg.sender != authorization.executor) {
            revert UnauthorizedExecutor(authorization.executor, msg.sender);
        }
        if (block.timestamp > authorization.deadline) {
            revert AuthorizationExpired(authorization.deadline, block.timestamp);
        }
        if (authorizationUsed[authorization.user][authorization.nonce]) {
            revert AuthorizationAlreadyUsed(authorization.user, authorization.nonce);
        }
        uint256 currentRevocationNonce = revocationNonces[authorization.user];
        if (authorization.revocationNonce != currentRevocationNonce) {
            revert AuthorizationRevoked(authorization.revocationNonce, currentRevocationNonce);
        }
        if (authorization.repayAmount == 0 || authorization.collateralAmount == 0 || authorization.expectedSwapOut == 0)
        {
            revert InvalidAmount();
        }
        if (authorization.repayAmount > authorization.maxRepayment) {
            revert RepaymentExceedsMaximum(authorization.repayAmount, authorization.maxRepayment);
        }
        if (authorization.collateralAmount > authorization.maxCollateral) {
            revert CollateralExceedsMaximum(authorization.collateralAmount, authorization.maxCollateral);
        }
        if (authorization.maxSlippageBps > BPS) revert InvalidSlippageBps(authorization.maxSlippageBps);
        if (authorization.maxFlashLoanPremiumBps > BPS) {
            revert InvalidFlashLoanPremiumBps(authorization.maxFlashLoanPremiumBps);
        }
        uint256 maximumOwed =
            authorization.repayAmount + _percentMulUp(authorization.repayAmount, authorization.maxFlashLoanPremiumBps);
        if (authorization.minSwapOut < maximumOwed) {
            revert SwapOutputBelowAuthorization(authorization.minSwapOut, maximumOwed);
        }
        if (authorization.expectedSwapOut < authorization.minSwapOut) {
            revert QuoteBelowSignedMinimum(authorization.expectedSwapOut, authorization.minSwapOut);
        }

        uint256 slippageFloor = authorization.expectedSwapOut * (BPS - authorization.maxSlippageBps) / BPS;
        if (authorization.minSwapOut < slippageFloor) {
            revert SwapOutputBelowSlippageFloor(authorization.minSwapOut, slippageFloor);
        }

        bytes32 digest = _authorizationDigest(authorization);
        address recovered = ECDSA.recover(digest, signature.v, signature.r, signature.s);
        if (recovered != authorization.user) {
            revert InvalidAuthorizationSigner(recovered, authorization.user);
        }
    }

    function _validateProtectionPolicy(ProtectionPolicy calldata policy, Signature calldata signature)
        internal
        view
        returns (bytes32 digest)
    {
        if (policy.user == address(0) || policy.keeper == address(0) || policy.riskAttestor == address(0)) {
            revert ZeroAddress();
        }
        if (
            policy.protocolConfigHash != PROTOCOL_CONFIG_HASH || policy.minimumRiskLevel < RISK_HIGH
                || policy.minimumRiskLevel > RISK_CRITICAL || policy.maxRepaymentPerExecution == 0
                || policy.maxCollateralPerExecution == 0 || policy.maxCumulativeRepayment == 0
                || policy.maxCumulativeCollateral == 0
                || policy.maxRepaymentPerExecution > policy.maxCumulativeRepayment
                || policy.maxCollateralPerExecution > policy.maxCumulativeCollateral
                || policy.maxCollateralPercentageBps == 0 || policy.maxCollateralPercentageBps > BPS
                || policy.maxPositionDebt == 0 || policy.maxSlippageBps > BPS || policy.maxOracleDeviationBps > BPS
                || policy.maxFlashLoanPremiumBps > BPS || policy.maxPreHealthFactor >= policy.minPostHealthFactor
                || policy.maxExecutions == 0 || policy.maxRiskAgeSeconds == 0 || policy.expiresAt <= block.timestamp
        ) revert InvalidProtectionPolicy();
        uint256 currentRevocationNonce = revocationNonces[policy.user];
        if (policy.revocationNonce != currentRevocationNonce) {
            revert PolicyRevoked(policy.revocationNonce, currentRevocationNonce);
        }

        digest = _protectionPolicyDigest(policy);
        address recovered = ECDSA.recover(digest, signature.v, signature.r, signature.s);
        if (recovered != policy.user) revert InvalidPolicySigner(recovered, policy.user);
    }

    function _validateRiskAttestation(
        bytes32 policyId,
        ProtectionPolicy calldata policy,
        RiskAttestation calldata attestation
    ) internal view {
        if (attestation.policyId != policyId || attestation.riskEventId == bytes32(0)) {
            revert InvalidProtectionPolicy();
        }
        if (attestation.riskLevel < policy.minimumRiskLevel || attestation.riskLevel > RISK_CRITICAL) {
            revert RiskBelowPolicyThreshold(attestation.riskLevel, policy.minimumRiskLevel);
        }
        if (block.timestamp > attestation.expiresAt) {
            revert RiskAttestationExpired(attestation.expiresAt, block.timestamp);
        }
        if (attestation.issuedAt > block.timestamp + policy.maxClockSkewSeconds) {
            revert RiskAttestationFromFuture(attestation.issuedAt, block.timestamp, policy.maxClockSkewSeconds);
        }
        if (block.timestamp > attestation.issuedAt + policy.maxRiskAgeSeconds) {
            revert RiskAttestationStale(attestation.issuedAt, block.timestamp, policy.maxRiskAgeSeconds);
        }
        bytes32 digest = _riskAttestationDigest(attestation);
        address recovered =
            ECDSA.recover(digest, attestation.signature.v, attestation.signature.r, attestation.signature.s);
        if (recovered != policy.riskAttestor) revert InvalidRiskAttestor(recovered, policy.riskAttestor);
    }

    function _validateAutonomousExecution(
        ProtectionPolicy calldata policy,
        PolicyState storage state,
        AutonomousExecution calldata execution
    ) internal view {
        if (execution.repayAmount == 0 || execution.collateralAmount == 0 || execution.expectedSwapOut == 0) {
            revert InvalidAmount();
        }
        if (execution.repayAmount > policy.maxRepaymentPerExecution) {
            revert RepaymentExceedsMaximum(execution.repayAmount, policy.maxRepaymentPerExecution);
        }
        if (execution.collateralAmount > policy.maxCollateralPerExecution) {
            revert CollateralExceedsMaximum(execution.collateralAmount, policy.maxCollateralPerExecution);
        }
        uint256 maximumOwed =
            execution.repayAmount + _percentMulUp(execution.repayAmount, policy.maxFlashLoanPremiumBps);
        if (execution.minSwapOut < maximumOwed) {
            revert SwapOutputBelowAuthorization(execution.minSwapOut, maximumOwed);
        }
        if (execution.expectedSwapOut < execution.minSwapOut) {
            revert QuoteBelowSignedMinimum(execution.expectedSwapOut, execution.minSwapOut);
        }
        uint256 slippageFloor = execution.expectedSwapOut * (BPS - policy.maxSlippageBps) / BPS;
        if (execution.minSwapOut < slippageFloor) {
            revert SwapOutputBelowSlippageFloor(execution.minSwapOut, slippageFloor);
        }
        uint256 collateralPrice = IAaveOracle(AAVE_ORACLE).getAssetPrice(XBETH);
        uint256 debtPrice = IAaveOracle(AAVE_ORACLE).getAssetPrice(XETH);
        if (collateralPrice == 0) revert OraclePriceUnavailable(XBETH);
        if (debtPrice == 0) revert OraclePriceUnavailable(XETH);
        uint256 oracleAmountOut = execution.collateralAmount * collateralPrice / debtPrice;
        uint256 oracleFloor = oracleAmountOut * (BPS - policy.maxOracleDeviationBps) / BPS;
        if (execution.minSwapOut < oracleFloor) {
            revert SwapOutputBelowOracleFloor(execution.minSwapOut, oracleFloor);
        }
        if (state.cumulativeRepayment > policy.maxCumulativeRepayment) {
            revert PolicyCumulativeRepaymentExceeded(state.cumulativeRepayment, policy.maxCumulativeRepayment);
        }
        if (state.cumulativeCollateral > policy.maxCumulativeCollateral) {
            revert PolicyCumulativeCollateralExceeded(state.cumulativeCollateral, policy.maxCumulativeCollateral);
        }
    }

    function _authorizationDigest(Authorization calldata authorization) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                AUTHORIZATION_TYPEHASH,
                authorization.user,
                authorization.executor,
                authorization.repayAmount,
                authorization.collateralAmount,
                authorization.maxRepayment,
                authorization.maxCollateral,
                authorization.expectedSwapOut,
                authorization.minSwapOut,
                authorization.maxSlippageBps,
                authorization.maxFlashLoanPremiumBps,
                authorization.minPostHealthFactor,
                authorization.deadline,
                authorization.nonce,
                authorization.revocationNonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _protectionPolicyDigest(ProtectionPolicy calldata policy) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PROTECTION_POLICY_TYPEHASH,
                policy.user,
                policy.keeper,
                policy.riskAttestor,
                policy.protocolConfigHash,
                policy.minimumRiskLevel,
                policy.maxRepaymentPerExecution,
                policy.maxCollateralPerExecution,
                policy.maxCumulativeRepayment,
                policy.maxCumulativeCollateral,
                policy.maxCollateralPercentageBps,
                policy.maxPositionDebt,
                policy.maxSlippageBps,
                policy.maxOracleDeviationBps,
                policy.maxFlashLoanPremiumBps,
                policy.maxPreHealthFactor,
                policy.minPostHealthFactor,
                policy.cooldownSeconds,
                policy.maxExecutions,
                policy.maxRiskAgeSeconds,
                policy.maxClockSkewSeconds,
                policy.expiresAt,
                policy.nonce,
                policy.revocationNonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _riskAttestationDigest(RiskAttestation calldata attestation) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                RISK_ATTESTATION_TYPEHASH,
                attestation.policyId,
                attestation.riskEventId,
                attestation.verdictHash,
                attestation.evidenceHash,
                attestation.riskLevel,
                attestation.issuedAt,
                attestation.expiresAt
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", RISK_DOMAIN_SEPARATOR, structHash));
    }

    function _runFlashLoan(ActiveExecution memory execution) internal {
        uint256 xethBalanceBefore = _balanceOf(XETH, address(this));
        uint256 xbEthBalanceBefore = _balanceOf(XBETH, address(this));
        uint256 aXbEthBalanceBefore = A_XBETH.balanceOf(address(this));
        _active = execution;

        AAVE_POOL.flashLoanSimple(
            address(this),
            XETH,
            execution.repayAmount,
            abi.encode(
                CallbackData({
                    user: execution.user,
                    collateralAmount: execution.collateralAmount,
                    minSwapOut: execution.minSwapOut,
                    minPostHealthFactor: execution.minPostHealthFactor,
                    maxFlashLoanPremiumBps: execution.maxFlashLoanPremiumBps,
                    debtBefore: execution.debtBefore,
                    collateralBefore: execution.collateralBefore,
                    nonce: execution.nonce,
                    authorizationHash: execution.authorizationHash
                })
            ),
            0
        );

        if (_active.user != address(0)) revert FlashLoanNotActive();
        _assertBalancesRestored(xethBalanceBefore, xbEthBalanceBefore, aXbEthBalanceBefore);
    }

    function _healthFactor(address user) internal view returns (uint256 healthFactor) {
        (,,,,, healthFactor) = AAVE_POOL.getUserAccountData(user);
    }

    // Aave can charge the indivisible-wei premium remainder upward.
    function _percentMulUp(uint256 value, uint256 percentageBps) internal pure returns (uint256) {
        return (value * percentageBps + BPS - 1) / BPS;
    }

    function _absoluteDifference(uint256 left, uint256 right) internal pure returns (uint256) {
        return left >= right ? left - right : right - left;
    }

    function _balanceOf(address token, address account) internal view returns (uint256 value) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!success || data.length < 32) revert InvalidProtocolConfiguration();
        value = abi.decode(data, (uint256));
    }

    function _assertBalancesRestored(uint256 expectedXeth, uint256 expectedXbEth, uint256 expectedAXbEth)
        internal
        view
    {
        uint256 xethBalance = _balanceOf(XETH, address(this));
        if (xethBalance != expectedXeth) revert BalanceNotRestored(XETH, expectedXeth, xethBalance);
        uint256 xbEthBalance = _balanceOf(XBETH, address(this));
        if (xbEthBalance != expectedXbEth) revert BalanceNotRestored(XBETH, expectedXbEth, xbEthBalance);
        uint256 aXbEthBalance = A_XBETH.balanceOf(address(this));
        if (aXbEthBalance != expectedAXbEth) {
            revert BalanceNotRestored(address(A_XBETH), expectedAXbEth, aXbEthBalance);
        }
    }
}
