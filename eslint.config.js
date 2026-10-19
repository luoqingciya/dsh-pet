// ESLint 扁平配置（ESLint 9 flat config）
// 规则基调：js recommended + typescript-eslint recommended（未使用变量/类型相关规则）
//           + react-hooks 钩子规则（client 半侧是 React 代码）
// 忽略：构建产物 lib、发布前检查脚本 scripts、素材 assets（类型正确性交给 tsc，
//       因此 TS 文件关闭 no-undef，避免 window/fetch 等全局误报）
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'lib/**',
      'dist/**',
      'scripts/**',
      'tools/**',
      'assets/**',
      'node_modules/**',
      'src/desktop/shared-core.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 桌面窗口层：经典 script（非 ES 模块），文件之间靠全局变量通信（S / VIEW / toScreen …），
    // 且混用 browser 与 node（windows.js 是 CJS）。逐个声明这些全局收益太低，
    // 这里关掉 no-undef；其余规则（未使用变量、重复声明、可疑写法）照常生效。
    files: ['src/desktop/**/*.js'],
    // 这些是经典 script（不是 ES 模块）：顶层声明即全局，跨文件共享
    languageOptions: { sourceType: 'script' },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // 经典 script 的顶层定义是给别的文件用的（PetSprite / PetShared），不算未使用；
      // 只查函数/块内的局部变量——那才是真写错了的地方。
      'no-unused-vars': ['error', { vars: 'local', args: 'after-used' }],
    },
  },
  {
    // TS 文件：类型正确性由 tsc 负责，关闭 no-undef（避免 window/fetch 等全局误报）
    files: ['**/*.ts'],
    rules: {
      'no-undef': 'off',
    },
  },
  {
    // client 半侧是 React 代码（hooks + 手写 h() 元素）：
    // rules-of-hooks 强制 hook 调用顺序稳定；exhaustive-deps 提醒 useEffect 依赖遗漏
    files: ['src/client/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // 本地应用设置页（React 组件，浏览器 bundle）：同一套 hooks 规则
    files: ['src/ui/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // 配置文件本身用的 ESM import，无浏览器代码，no-undef 放开
    files: ['eslint.config.js'],
    rules: {
      'no-undef': 'off',
    },
  },
);
