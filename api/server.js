/**
 * KuGouMusic API 服务器核心模块
 *
 * 基于 Express 框架构建的 HTTP 服务，负责动态加载 API 模块、处理 CORS、
 * 解析 Cookie、注入平台标识、缓存响应、统一错误处理。
 */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const decode = require('safe-decode-uri-component');
const { cookieToJson, randomString, getGuid, calculateMid, generateWebGLHash } = require('./util/util');
const { cryptoMd5 } = require('./util/crypto');
const { createRequest } = require('./util/request');
const dotenv = require('dotenv');
const cache = require('./util/apicache').middleware;

/**
 * @typedef {{ identifier?: string; route: string; module: any }} ModuleDefinition
 * @typedef {{ server?: import('http').Server }} ExpressExtension
 */

// ========== 全局设备标识常量 ==========
/** 全局唯一设备 GUID（MD5 哈希） */
const guid = cryptoMd5(getGuid());
/** 随机 10 位大写开发设备标识 */
const serverDev = randomString(10).toUpperCase();

// ========== 加载环境变量 ==========
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
}

/**
 * 动态扫描指定目录获取所有 API 模块定义
 * @param {string} modulesPath - 模块目录路径
 * @param {Record<string, string>} specificRoute - 特定路由映射
 * @param {boolean} [doRequire=true] - 是否实际加载模块
 * @returns {Promise<ModuleDefinition[]>}
 */
async function getModulesDefinitions(modulesPath, specificRoute, doRequire = true) {
  const files = await fs.promises.readdir(modulesPath);
  const parseRoute = (fileName) =>
    specificRoute && fileName in specificRoute
      ? specificRoute[fileName]
      : `/${fileName.replace(/\.(js)$/i, '').replace(/_/g, '/')}`;

  return files
    .reverse()
    .filter((fileName) => fileName.endsWith('.js') && !fileName.startsWith('_'))
    .map((fileName) => {
      const identifier = fileName.split('.').shift();
      const route = parseRoute(fileName);
      const modulePath = path.resolve(modulesPath, fileName);
      const module = doRequire ? require(modulePath) : modulePath;
      return { identifier, route, module };
    });
}

/**
 * 构建并配置 Express 应用实例
 * @param {ModuleDefinition[]} [moduleDefs]
 * @returns {Promise<import('express').Express>}
 */
async function consturctServer(moduleDefs) {
  const app = express();
  const { CORS_ALLOW_ORIGIN } = process.env;
  app.set('trust proxy', true);

  /**
   * CORS 跨域中间件
   */
  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      res.set({
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN || req.headers.origin || '*',
        'Access-Control-Allow-Headers': 'Authorization,X-Requested-With,Content-Type,Cache-Control',
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    req.method === 'OPTIONS' ? res.status(204).end() : next();
  });

  /**
   * Cookie 解析中间件
   */
  app.use((req, _, next) => {
    req.cookies = {};
    (req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      const crack = pair.indexOf('=');
      if (crack < 1 || crack === pair.length - 1) {
        return;
      }
      req.cookies[decode(pair.slice(0, crack)).trim()] = decode(pair.slice(crack + 1)).trim();
    });
    next();
  });

  /**
   * 平台标识 Cookie 注入中间件
   * 自动注入 KUGOU_API_PLATFORM / MID / GUID / DEV / MAC / WEBGL
   */
  app.use((req, res, next) => {
    const cookies = req.cookies || {};
    const isHttps = req.protocol === 'https';
    const cookieSuffix = isHttps ? '; PATH=/; SameSite=None; Secure' : '; PATH=/';

    const ensureCookie = (key, value) => {
      if (Object.prototype.hasOwnProperty.call(cookies, key)) return;
      cookies[key] = String(value);
      res.append('Set-Cookie', `${key}=${cookies[key]}${cookieSuffix}`);
    };

    const mid = calculateMid(process.env.KUGOU_API_GUID ?? guid);
    ensureCookie('KUGOU_API_PLATFORM', process.env.platform);
    ensureCookie('KUGOU_API_MID', mid);
    ensureCookie('KUGOU_API_GUID', process.env.KUGOU_API_GUID ?? guid);
    ensureCookie('KUGOU_API_DEV', (process.env.KUGOU_API_DEV ?? serverDev).toUpperCase());
    ensureCookie('KUGOU_API_MAC', (process.env.KUGOU_API_MAC ?? '02:00:00:00:00:00').toUpperCase());
    ensureCookie('KUGOU_API_WEBGL', process.env.KUGOU_API_WEBGL ?? generateWebGLHash());

    req.cookies = cookies;
    next();
  });

  /**
   * 请求体解析中间件（含大小限制）
   */
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: false, limit: '5mb' }));
  app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));

  /**
   * 静态文件服务
   */
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/docs', express.static(path.join(__dirname, 'docs')));

  /**
   * API 响应缓存（2 分钟，仅缓存成功请求）
   */
  app.use(cache('2 minutes', (_, res) => res.statusCode === 200));

  /**
   * 动态路由注册
   */
  const moduleDefinitions = moduleDefs || (await getModulesDefinitions(path.join(__dirname, 'module'), {}));

  for (const moduleDef of moduleDefinitions) {
    app.use(moduleDef.route, async (req, res) => {
      // 解析 query 和 body 中的 cookie 字符串
      [req.query, req.body].forEach((item) => {
        if (typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie));
        }
      });

      const { cookie, ...params } = req.query;
      const body = Buffer.isBuffer(req.body) ? { data: req.body } : req.body;
      const query = Object.assign({}, { cookie: Object.assign({}, req.cookies, cookie) }, params, body);

      // Authorization 头解析为 Cookie
      const authHeader = req.headers['authorization'];
      if (authHeader) {
        query.cookie = {
          ...query.cookie,
          ...cookieToJson(authHeader),
        };
      }

      try {
        const moduleResponse = await moduleDef.module(query, (config) => {
          let ip = req.ip;
          if (ip.substring(0, 7) === '::ffff:') {
            ip = ip.substring(7);
          }
          config.ip = ip;
          return createRequest(config);
        });

        console.log('[OK]', decode(req.originalUrl));

        // 处理模块返回的 Cookie
        const cookies = moduleResponse.cookie;
        if (!query.noCookie) {
          if (Array.isArray(cookies) && cookies.length > 0) {
            if (req.protocol === 'https') {
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => `${cookie}; PATH=/; SameSite=None; Secure`)
              );
            } else {
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => `${cookie}; PATH=/`)
              );
            }
          }
        }

        res.header(moduleResponse.headers).status(moduleResponse.status).send(moduleResponse.body);
      } catch (e) {
        const moduleResponse = e;
        if (!moduleResponse.body) {
          res.status(404).send({
            code: 404,
            data: null,
            msg: 'Not Found',
          });
          return;
        }
        res.header(moduleResponse.headers).status(moduleResponse.status).send(moduleResponse.body);
      }
    });
  }

  return app;
}

/**
 * 启动 HTTP 服务
 * @returns {Promise<import('express').Express & ExpressExtension>}
 */
async function startService() {
  const port = Number(process.env.PORT || '3000');
  const host = process.env.HOST || '127.0.0.1';

  const app = await consturctServer();

  /** @type {import('express').Express & ExpressExtension} */
  const appExt = app;

  appExt.service = app.listen(port, host, () => {
    console.log(`server running @ http://${host || 'localhost'}:${port}`);
  });

  return appExt;
}

module.exports = { startService, getModulesDefinitions };
