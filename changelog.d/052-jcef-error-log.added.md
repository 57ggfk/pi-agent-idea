插件会在用户未自行设置日志级别时把 JCEF 日志级别调到 error，让 GPU 崩溃记录真正可见（用户设过就不动）。
The plugin raises the JCEF log level to "error" when the user has not chosen one, so GPU crash records actually show up.
