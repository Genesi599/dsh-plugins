/**
 * Host loader entry.
 *
 * DSH 的 bundle 行按 package `main` 解析，这里必须**转出真正的 Host 半**（`../index.js`）。
 * 之前这里是个空 `apply()`，导致 Host 半（管理者协议注入、测试会话自动归档、/hub/restart）
 * 从来没有被加载过——客户端半一切正常，所以一直没被发现。
 */
export * from '../index.js';
