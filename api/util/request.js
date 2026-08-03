/**
 * 酷狗音乐 API HTTP 请求封装
 *
 * 负责构建请求参数、生成签名、配置请求头、发送请求、处理响应与 SSA 二次验证。
 */
const axios = require('axios');
const { signKey, signatureAndroidParams, signatureRegisterParams, signatureWebParams } = require('./helper');
const { parseCookieString } = require('./util');
const { appid, clientver, liteAppid, liteClientver } = require('./config.json');
const { resolveProxy } = require('./runtime');
const { generateSimulate } = require('./generate_simulate');

/**
 * @typedef {{status: number; body: any; cookie: string[]; headers?: Record<string, string>}} UseAxiosResponse
 */

/**
 * 创建并发送 API 请求
 * @param {Object} options
 * @param {'get' | 'GET' | 'post' | 'POST'} options.method
 * @param {string} options.url
 * @param {string} [options.baseURL]
 * @param {Record<string, any>} [options.params]
 * @param {Record<string, any>} [options.data]
 * @param {Record<string, string | number>} [options.headers]
 * @param {'android' | 'web' | 'register'} options.encryptType
 * @param {Object} options.cookie
 * @param {boolean} [options.encryptKey]
 * @param {boolean} [options.clearDefaultParams]
 * @param {boolean} [options.notSignature]
 * @param {string} [options.ip]
 * @param {string} [options.realIP]
 * @returns {Promise<UseAxiosResponse>}
 */
const createRequest = (options) => {
  return new Promise(async (resolve, reject) => {
    const isLite = process.env.platform === 'lite';

    // ========== 从 Cookie 中提取设备标识 ==========
    const dfid = options?.cookie?.dfid || '-';
    const mid = `${options?.cookie?.KUGOU_API_MID}`;
    const uuid = '-';
    const token = options?.cookie?.token || '';
    const userid = options?.cookie?.userid || 0;
    const clienttime = Math.floor(Date.now() / 1000);
    const ip = options?.realIP || options?.ip || '';
    const webglHash = options?.cookie?.KUGOU_API_WEBGL;

    // ========== 构建请求头 ==========
    const headers = {
      dfid,
      clienttime,
      mid,
      'kg-rc': '1',
      'kg-thash': '5d816a0',
      'kg-rec': 1,
      'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    };

    if (ip) {
      headers['X-Real-IP'] = ip;
      headers['X-Forwarded-For'] = ip;
    }

    // ========== 构建默认请求参数 ==========
    const defaultParams = {
      dfid,
      mid,
      uuid,
      appid: isLite ? liteAppid : appid,
      clientver: isLite ? liteClientver : clientver,
      clienttime,
    };

    if (token) defaultParams['token'] = token;
    if (userid && userid !== 0) defaultParams['userid'] = userid;

    const params = options?.clearDefaultParams ? options?.params || {} : Object.assign({}, defaultParams, options?.params || {});

    headers['clienttime'] = params.clienttime;

    // ========== 生成 signKey（可选） ==========
    if (options?.encryptKey) {
      params['key'] = signKey(params['hash'], params['mid'], params['userid'], params['appid']);
    }

    // ========== 序列化请求体 ==========
    const data = Buffer.isBuffer(options?.data)
      ? options.data
      : typeof options?.data === 'object'
        ? JSON.stringify(options.data)
        : options?.data || '';

    // ========== 生成请求签名 ==========
    if (!params['signature'] && !options.notSignature) {
      switch (options?.encryptType) {
        case 'register':
          params['signature'] = signatureRegisterParams(params);
          break;
        case 'web':
          params['signature'] = signatureWebParams(params);
          break;
        case 'android':
        default:
          params['signature'] = signatureAndroidParams(params, data);
          break;
      }
    }

    // ========== 配置请求选项 ==========
    options['params'] = params;
    options['baseURL'] = options?.baseURL || 'https://gateway.kugou.com';
    options['headers'] = Object.assign(
      { 'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi' },
      options?.headers || {},
      {
        dfid,
        clienttime: params.clienttime,
        mid,
      }
    );

    const requestOptions = {
      params,
      data: options?.data,
      method: options.method,
      baseURL: options?.baseURL,
      url: options.url,
      headers: Object.assign({}, options?.headers || {}, headers),
      withCredentials: true,
      responseType: options.responseType,
    };

    // ========== 代理配置 ==========
    const proxyConfig = resolveProxy();
    if (proxyConfig) {
      requestOptions.proxy = proxyConfig;
    }

    if (options.data) requestOptions.data = options.data;
    if (params) requestOptions.params = params;

    // ========== CDN 接口特殊处理 ==========
    if (options.baseURL?.includes('openapicdn')) {
      const url = requestOptions.url;
      const _params = Object.keys(params)
        .map((key) => `${key}=${params[key]}`)
        .join('&');
      requestOptions.url = `${url}?${_params}`;
      requestOptions.params = {};
    }

    // ========== 发送请求 ==========
    const answer = { status: 500, body: {}, cookie: [], headers: {} };
    try {
      const response = await axios(requestOptions);
      let ssaCode = '';
      const body = response.data;

      answer.cookie = (response.headers['set-cookie'] || []).map((x) => parseCookieString(x));

      // ========== SSA 验证码处理 ==========
      if (response.headers['ssa-code'] || response.headers['SSA-CODE']) {
        const _ssaCode = response.headers['ssa-code'] || response.headers['SSA-CODE'];
        answer.headers['ssa-code'] = _ssaCode;
        ssaCode = _ssaCode;
      }

      // 解析响应体为 JSON
      try {
        answer.body = JSON.parse(body.toString());
      } catch (error) {
        answer.body = body;
      }

      // ========== 响应状态判断 ==========
      if (response.data.status === 0 || (response.data?.error_code && response.data.error_code !== 0)) {
        answer.status = 502;
        if (ssaCode) {
          const { edt, sid } = generateSimulate(mid, userid, dfid, webglHash);
          if (edt) answer.body.edt = edt;
          if (sid) answer.body.sid = sid;
          answer.body.ssaCode = ssaCode;
        }
        reject(answer);
      } else {
        answer.status = 200;
        if (ssaCode) {
          const { edt, sid } = generateSimulate(mid, userid, dfid, webglHash);
          if (edt) answer.body.edt = edt;
          if (sid) answer.body.sid = sid;
          answer.body.ssaCode = ssaCode;
        }
        resolve(answer);
      }
    } catch (e) {
      answer.status = 502;
      answer.body = { status: 0, msg: e };
      reject(answer);
    }
  });
};

module.exports = { createRequest };
