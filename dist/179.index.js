"use strict";
exports.id = 179;
exports.ids = [179];
exports.modules = {

/***/ 77179:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {


// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  digest: () => (/* reexport */ digest)
});

// UNUSED EXPORTS: hash, isEqual, serialize

// EXTERNAL MODULE: external "node:crypto"
var external_node_crypto_ = __webpack_require__(77598);
;// CONCATENATED MODULE: ./node_modules/ohash/dist/crypto/node/index.mjs

const fastHash = /*@__PURE__*/ (() => globalThis.process?.getBuiltinModule?.("crypto")?.hash)();
const algorithm = "sha256";
const encoding = "base64url";
function digest(data) {
	if (fastHash) return fastHash(algorithm, data, encoding);
	const h = (0,external_node_crypto_.createHash)(algorithm).update(data);
	return globalThis.process?.versions?.webcontainer ? h.digest().toString(encoding) : h.digest(encoding);
}


;// CONCATENATED MODULE: ./node_modules/ohash/dist/index.mjs


function hash(input) {
	return digest$1(serialize(input));
}



/***/ })

};
;