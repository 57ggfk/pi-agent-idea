# changelog.d

发布文案碎片目录。**一个用户可见变化一个文件**，改动落地时就写，不要攒到发版再回忆。

## 文件名

    <slug>.<added|changed|fixed>.md

- `slug`：小写字母、数字、连字符。建议带规格号，如 `024-session-rename.added.md`
- 类型只有三种：`added`（新增能力）、`changed`（既有行为改变）、`fixed`（缺陷修复）

## 内容：正好两行非空

    会话可以在列表里直接重命名
    Sessions can be renamed straight from the list

第 1 行中文，第 2 行英文，一一对应。允许 `**粗体**` 与 `代码` 标记（商店面板能渲染）。

只写**用户能看到的变化**：不写类名、文件名、commit、内部机制、版本号。
一条只讲一件事——汇总时同类会合并，写长了就得返工。

## 汇总（发版时执行一次）

    ./gradlew collectChangelog

- 把全部碎片按 新增/变更/修复 汇总成 `CHANGELOG.md` 顶部的新 `## <version> — <date>` 段
- 默认删除已消费的碎片；`-PkeepFragments=true` 保留
- `-PdryRun=true` 只打印结果，不写文件、不删碎片
- `-PreleaseDate=2026-11-30` 指定发布日（默认当天；发布日是真正的上架日期，不是写文案的日期）
- 目标版本段已存在时**中止**，不会重复插入

`CHANGELOG.md` 仍是发布文案的唯一来源：商店 What's New（`build.gradle.kts` 的 `changeNotes`）与
GitHub Release notes 都从它的版本段切出来，所以碎片汇总完就不要再单独改这两处。

## 校验

CI（`.github/workflows/build.yml` 的 `changelog` job）检查文件名、类型、是否正好两行、
中英是否各就各位。文件名不合格或行数不对会直接挡下。
