/**
 * 极小的 Node ESM loader：把无扩展名的相对导入解析到 .ts / .tsx / .json。
 *
 * 为什么需要：
 *   源码用的是 Vite 风格的无扩展名导入（import './db'）。
 *   Node 的 ESM 解析器要求显式扩展名，所以裸 node 跑不了这些模块。
 *   之前靠 vite-node 解决，但它会拉进一个不同大版本的 vite，
 *   让 package-lock.json 里出现两套 esbuild，CI 的 npm ci 变得很脆。
 *   与其为了测试引入重型工具链，不如自己写 30 行解析钩子。
 *
 * 用法: node --import ./tools/ts-loader.mjs --experimental-strip-types <script>
 *   （见 package.json 的 test 脚本）
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./ts-resolver.mjs', import.meta.url), pathToFileURL('./'));
