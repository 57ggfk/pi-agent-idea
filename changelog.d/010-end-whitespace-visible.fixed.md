会话末尾的留白滚动到底现在真的可见了——此前留白写在滚动容器上被 Chromium 吞掉（36px 只剩 12.5px），改为消息列内部的收尾元素
The end-of-conversation whitespace is now actually visible when you scroll to the bottom — it used to be written on the scroll container where Chromium drops bottom padding (36px shrank to 12.5px); it now lives as an element inside the scrolled content
