// ========== 配置常量 ==========
const { apiver, appid, wx_appid, wx_lite_appid, srcappid, clientver, liteAppid, liteClientver } = require('./config.json');
const wx_secret = process.env.KUGOU_WX_SECRET || require('./config.json').wx_secret;
const wx_lite_secret = process.env.KUGOU_WX_LITE_SECRET || require('./config.json').wx_lite_secret;

// ========== 加密函数 ==========
const {
  cryptoAesDecrypt,
  cryptoAesEncrypt,
  cryptoMd5,
  cryptoRSAEncrypt,
  cryptoSha1,
  rsaEncrypt2,
  playlistAesEncrypt,
  playlistAesDecrypt,
  publicLiteRasKey,
  publicRasKey,
} = require('./crypto');

// ========== 请求函数 ==========
const { createRequest } = require('./request');

// ========== 签名函数 ==========
const { signKey, signParams, signParamsKey, signCloudKey, signatureAndroidParams, signatureRegisterParams, signatureWebParams } = require('./helper');

// ========== 工具函数 ==========
const { randomString, decodeLyrics, parseCookieString, cookieToJson, randomNumber, calculateMid } = require('./util');

// ========== 平台判断 ==========
const isLite = process.env.platform === 'lite';
const useAppid = isLite ? liteAppid : appid;
const useClientver = isLite ? liteClientver : clientver;

module.exports = {
  // --- 配置常量 ---
  apiver,
  appid: useAppid,
  wx_appid,
  wx_lite_appid,
  wx_secret,
  wx_lite_secret,
  srcappid,
  clientver: useClientver,
  isLite,
  // --- 加密函数 ---
  cryptoAesDecrypt,
  cryptoAesEncrypt,
  cryptoMd5,
  cryptoRSAEncrypt,
  cryptoSha1,
  rsaEncrypt2,
  playlistAesEncrypt,
  playlistAesDecrypt,
  // --- 请求函数 ---
  createRequest,
  // --- 签名函数 ---
  signKey,
  signParams,
  signParamsKey,
  signCloudKey,
  signatureAndroidParams,
  signatureRegisterParams,
  signatureWebParams,
  // --- 工具函数 ---
  randomString,
  decodeLyrics,
  parseCookieString,
  cookieToJson,
  publicLiteRasKey,
  publicRasKey,
  randomNumber,
  calculateMid,
};
