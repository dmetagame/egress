// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

library ECDSA {
    error InvalidSignature();
    error InvalidSignatureS();
    error InvalidSignatureV();

    // secp256k1n / 2, used to reject malleable signatures.
    uint256 private constant _HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    function recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal pure returns (address signer) {
        if (uint256(s) > _HALF_ORDER) revert InvalidSignatureS();
        if (v != 27 && v != 28) revert InvalidSignatureV();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
