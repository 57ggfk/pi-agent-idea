修复切进富内容会话后不自动滚到底、跳底按钮不出现的问题——消息列改为真实长高（不再被压扁在最小高度地板上、内容溢出盒子之外），并用 ResizeObserver 跟随内容生长
Fixed switching into content-rich sessions not auto-scrolling to the bottom with no jump button — the message column now grows with its real content (no longer squashed at the min-height floor with children overflowing its box) and a ResizeObserver follows late growth
