Skills 面板按目录来源分组（用户 .pi / 用户规范目录 ~/.agents / 项目 .pi / 项目 .agents 含祖先 / 扩展包 / 外接），每个技能可一键启用/禁用（settings 排除条目，不改技能文件），并显示全局/项目、仅手动调用、重名等状态（034）。
外接技能目录开关：把 ~/.claude/skills、~/.codex/skills 或任意自定义目录接入 pi 技能体系（settings skills 数组），外接技能带独立来源标记（034）。
技能的「仅手动调用」（disable-model-invocation）现在可以在面板里直接切换，不再需要手改 SKILL.md；切换后提供一键重载 pi 进程（034）。
