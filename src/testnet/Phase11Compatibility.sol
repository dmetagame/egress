// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IPhase11FlashLoanReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}

contract Phase11Token {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    address public immutable owner;

    mapping(address account => uint256 balance) public balanceOf;
    mapping(address account => mapping(address spender => uint256 amount)) public allowance;
    mapping(address account => bool enabled) public minters;

    error Unauthorized();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        owner = msg.sender;
        minters[msg.sender] = true;
    }

    function setMinter(address account, bool enabled) external {
        if (msg.sender != owner) revert Unauthorized();
        if (account == address(0)) revert ZeroAddress();
        minters[account] = enabled;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) {
            if (approved < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = approved - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external {
        if (!minters[msg.sender]) revert Unauthorized();
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function burnFrom(address from, uint256 amount) external {
        if (!minters[msg.sender]) revert Unauthorized();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        balanceOf[from] = balance - amount;
        totalSupply -= amount;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        balanceOf[from] = balance - amount;
        balanceOf[to] += amount;
    }
}

contract Phase11AToken is Phase11Token {
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    address public immutable POOL;
    address public immutable UNDERLYING_ASSET_ADDRESS;
    bytes32 public immutable DOMAIN_SEPARATOR;
    mapping(address account => uint256 nonce) public nonces;

    error PermitExpired();
    error InvalidPermitSigner();

    constructor(address pool, address underlying) Phase11Token("Egress Testnet Aave xBETH", "atxBETH", 18) {
        POOL = pool;
        UNDERLYING_ASSET_ADDRESS = underlying;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function permit(address owner_, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (block.timestamp > deadline) revert PermitExpired();
        uint256 nonce = nonces[owner_]++;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(PERMIT_TYPEHASH, owner_, spender, value, nonce, deadline))
            )
        );
        if (ecrecover(digest, v, r, s) != owner_) revert InvalidPermitSigner();
        allowance[owner_][spender] = value;
    }
}

contract Phase11VariableDebtToken is Phase11Token {
    address public immutable POOL;
    address public immutable UNDERLYING_ASSET_ADDRESS;

    constructor(address pool, address underlying)
        Phase11Token("Egress Testnet Variable Debt xETH", "variableDebtTxETH", 18)
    {
        POOL = pool;
        UNDERLYING_ASSET_ADDRESS = underlying;
    }
}

contract Phase11AddressesProvider {
    address public immutable owner;
    address private _pool;
    address private _priceOracle;

    error Unauthorized();

    constructor() {
        owner = msg.sender;
    }

    function configure(address pool_, address priceOracle_) external {
        if (msg.sender != owner) revert Unauthorized();
        _pool = pool_;
        _priceOracle = priceOracle_;
    }

    function getPool() external view returns (address) {
        return _pool;
    }

    function getPriceOracle() external view returns (address) {
        return _priceOracle;
    }
}

contract Phase11Oracle {
    address public immutable owner;
    mapping(address asset => uint256 price) public prices;

    error Unauthorized();

    constructor() {
        owner = msg.sender;
    }

    function setAssetPrice(address asset, uint256 price) external {
        if (msg.sender != owner) revert Unauthorized();
        prices[asset] = price;
    }

    function getAssetPrice(address asset) external view returns (uint256) {
        return prices[asset];
    }

    function getSourceOfAsset(address) external view returns (address) {
        return address(this);
    }
}

contract Phase11AavePool {
    uint128 public constant FLASHLOAN_PREMIUM_TOTAL = 5;
    uint256 public constant LIQUIDATION_THRESHOLD_BPS = 9_110;
    uint256 public constant LTV_BPS = 8_500;

    address public immutable ADDRESSES_PROVIDER;
    address public immutable owner;
    Phase11Oracle public immutable oracle;
    Phase11Token public immutable xbEth;
    Phase11Token public immutable xeth;
    Phase11AToken public aXbEth;
    Phase11VariableDebtToken public variableDebtXeth;

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidAsset();
    error FlashLoanFailed();

    constructor(address provider, address oracle_, address xbEth_, address xeth_) {
        ADDRESSES_PROVIDER = provider;
        owner = msg.sender;
        oracle = Phase11Oracle(oracle_);
        xbEth = Phase11Token(xbEth_);
        xeth = Phase11Token(xeth_);
    }

    function configureReserves(address aXbEth_, address variableDebtXeth_) external {
        if (msg.sender != owner) revert Unauthorized();
        if (address(aXbEth) != address(0) || address(variableDebtXeth) != address(0)) {
            revert InvalidConfiguration();
        }
        aXbEth = Phase11AToken(aXbEth_);
        variableDebtXeth = Phase11VariableDebtToken(variableDebtXeth_);
    }

    function seedPosition(address user, uint256 collateralAmount, uint256 debtAmount) external {
        if (msg.sender != owner) revert Unauthorized();
        if (address(aXbEth) == address(0) || address(variableDebtXeth) == address(0)) {
            revert InvalidConfiguration();
        }
        xbEth.mint(address(this), collateralAmount);
        aXbEth.mint(user, collateralAmount);
        variableDebtXeth.mint(user, debtAmount);
    }

    function seedFlashLiquidity(uint256 amount) external {
        if (msg.sender != owner) revert Unauthorized();
        xeth.mint(address(this), amount);
    }

    function getConfiguration(address asset) external view returns (uint256 data) {
        if (asset != address(xbEth) && asset != address(xeth)) revert InvalidAsset();
        uint256 ltv = asset == address(xbEth) ? LTV_BPS : 0;
        uint256 liquidationThreshold = asset == address(xbEth) ? LIQUIDATION_THRESHOLD_BPS : 0;
        uint256 borrowingEnabled = asset == address(xeth) ? 1 : 0;
        data = ltv | (liquidationThreshold << 16) | (10_500 << 32) | (uint256(18) << 48) | (uint256(1) << 56)
            | (borrowingEnabled << 58);
    }

    function getEModeCategoryData(uint8)
        external
        pure
        returns (
            uint16 ltv,
            uint16 liquidationThreshold,
            uint16 liquidationBonus,
            address priceSource,
            string memory label
        )
    {
        return (0, 0, 0, address(0), "");
    }

    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        )
    {
        totalCollateralBase =
            aXbEth.balanceOf(user) * oracle.prices(address(xbEth)) / 1e18;
        totalDebtBase = variableDebtXeth.balanceOf(user) * oracle.prices(address(xeth)) / 1e18;
        currentLiquidationThreshold = LIQUIDATION_THRESHOLD_BPS;
        ltv = LTV_BPS;
        uint256 borrowCapacity = totalCollateralBase * LTV_BPS / 10_000;
        availableBorrowsBase = borrowCapacity > totalDebtBase ? borrowCapacity - totalDebtBase : 0;
        healthFactor = totalDebtBase == 0
            ? type(uint256).max
            : totalCollateralBase * LIQUIDATION_THRESHOLD_BPS * 1e18 / (totalDebtBase * 10_000);
    }

    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16)
        external
    {
        if (asset != address(xeth)) revert InvalidAsset();
        uint256 premium = (amount * FLASHLOAN_PREMIUM_TOTAL + 9_999) / 10_000;
        uint256 balanceBefore = xeth.balanceOf(address(this));
        xeth.transfer(receiverAddress, amount);
        bool accepted =
            IPhase11FlashLoanReceiver(receiverAddress).executeOperation(asset, amount, premium, msg.sender, params);
        if (!accepted) revert FlashLoanFailed();
        xeth.transferFrom(receiverAddress, address(this), amount + premium);
        if (xeth.balanceOf(address(this)) < balanceBefore + amount + premium) revert FlashLoanFailed();
    }

    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256)
    {
        if (asset != address(xeth) || interestRateMode != 2) revert InvalidAsset();
        uint256 debt = variableDebtXeth.balanceOf(onBehalfOf);
        uint256 repaid = amount < debt ? amount : debt;
        xeth.transferFrom(msg.sender, address(this), repaid);
        variableDebtXeth.burnFrom(onBehalfOf, repaid);
        return repaid;
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        if (asset != address(xbEth)) revert InvalidAsset();
        aXbEth.burnFrom(msg.sender, amount);
        xbEth.transfer(to, amount);
        return amount;
    }
}

contract Phase11SwapFactory {
    address public immutable owner;
    address public pool;
    address public token0;
    address public token1;
    uint24 public fee;

    error Unauthorized();

    constructor() {
        owner = msg.sender;
    }

    function configure(address pool_, address token0_, address token1_, uint24 fee_) external {
        if (msg.sender != owner) revert Unauthorized();
        pool = pool_;
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    function getPool(address tokenA, address tokenB, uint24 fee_) external view returns (address) {
        return tokenA == token0 && tokenB == token1 && fee_ == fee ? pool : address(0);
    }
}

contract Phase11SwapPool {
    uint160 internal constant SQRT_PRICE_X96 = 79_228_162_514_264_337_593_543_950_336;
    address public immutable factory;
    address public immutable router;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint256 public immutable outputNumerator;
    uint256 public immutable outputDenominator;

    error Unauthorized();
    error InsufficientLiquidity();

    constructor(
        address factory_,
        address router_,
        address token0_,
        address token1_,
        uint24 fee_,
        uint256 outputNumerator_,
        uint256 outputDenominator_
    ) {
        factory = factory_;
        router = router_;
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        outputNumerator = outputNumerator_;
        outputDenominator = outputDenominator_;
    }

    function slot0()
        external
        pure
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (SQRT_PRICE_X96, 0, 0, 1, 1, 0, true);
    }

    function liquidity() external view returns (uint128) {
        uint256 balance0 = Phase11Token(token0).balanceOf(address(this));
        uint256 balance1 = Phase11Token(token1).balanceOf(address(this));
        uint256 minimum = balance0 < balance1 ? balance0 : balance1;
        return minimum > type(uint128).max ? type(uint128).max : uint128(minimum);
    }

    function quote(uint256 amountIn) public view returns (uint256) {
        return amountIn * outputNumerator / outputDenominator;
    }

    function payOut(address recipient, uint256 amountOut) external {
        if (msg.sender != router) revert Unauthorized();
        if (Phase11Token(token1).balanceOf(address(this)) < amountOut) revert InsufficientLiquidity();
        Phase11Token(token1).transfer(recipient, amountOut);
    }
}

contract Phase11SwapRouter {
    address public immutable factory;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    error InvalidSwap();

    constructor(address factory_) {
        factory = factory_;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut) {
        address poolAddress = Phase11SwapFactory(factory).getPool(params.tokenIn, params.tokenOut, params.fee);
        if (poolAddress == address(0) || params.sqrtPriceLimitX96 != 0) revert InvalidSwap();
        Phase11SwapPool pool = Phase11SwapPool(poolAddress);
        amountOut = pool.quote(params.amountIn);
        if (amountOut < params.amountOutMinimum) revert InvalidSwap();
        Phase11Token(params.tokenIn).transferFrom(msg.sender, poolAddress, params.amountIn);
        pool.payOut(params.recipient, amountOut);
    }
}

contract Phase11QuoterV2 {
    address public immutable factory;

    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    error InvalidQuote();

    constructor(address factory_) {
        factory = factory_;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams calldata params)
        external
        view
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
    {
        address poolAddress = Phase11SwapFactory(factory).getPool(params.tokenIn, params.tokenOut, params.fee);
        if (poolAddress == address(0) || params.sqrtPriceLimitX96 != 0) revert InvalidQuote();
        amountOut = Phase11SwapPool(poolAddress).quote(params.amountIn);
        return (amountOut, 79_228_162_514_264_337_593_543_950_336, 0, 120_000);
    }
}
