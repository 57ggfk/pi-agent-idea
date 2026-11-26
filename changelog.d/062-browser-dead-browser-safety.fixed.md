浏览器在底层浏览器失活时不再弹「IDE 内部错误」：渲染进程退出或启动竞态导致平台调用抛错时统一降级为安全默认值，页面关闭后不再刷新已释放的面板
The browser no longer raises "IDE internal errors" when the underlying browser dies: a renderer crash or a startup race that makes a platform call throw now degrades to a safe default, and a disposed panel is no longer refreshed
