/**
 * Host half of the hub-callout bundle.
 *
 * 渲染全在浏览器半（client.js）：DSH 内置的 markdown 渲染器没有扩展点
 * （@deepseek-ai/dsh-client-ui-primitives 的 blockquote 分支是硬编码的），
 * 所以这里只在 Host 侧登记插件行，不注册任何服务或路由。
 */

export const name = 'hub-callout';

/** Nothing to set up on the Host; the Client module owns the rendering. */
export function apply() {}