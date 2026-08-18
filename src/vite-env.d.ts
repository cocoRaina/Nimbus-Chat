/// <reference types="vite/client" />

// 构建身份戳（vite define 注入，见 vite.config.ts）：git sha + 构建号 + 时间。
declare const __BUILD_ID__: string
