# Word 预览字体

字体文件未修改。此包附带常规与粗体思源黑体、常规与粗体思源宋体，以及常规霞鹜文楷；总计 5 个字体文件。均按 SIL Open Font License 1.1 分发，字体不改用项目的 Apache-2.0 许可证。

| 字体     | 固定版本 | 官方来源                                                            |
| -------- | -------- | ------------------------------------------------------------------- |
| 思源黑体 | 2.005R   | https://github.com/adobe-fonts/source-han-sans/releases/tag/2.005R  |
| 思源宋体 | 2.003R   | https://github.com/adobe-fonts/source-han-serif/releases/tag/2.003R |
| 霞鹜文楷 | v1.522   | https://github.com/lxgw/LxgwWenKai/releases/tag/v1.522              |

原始下载 URL、大小和 SHA-256 保存在 `packages/server/assets/document-fonts/manifest.json`。该目录同时保留三份完整许可证与作者声明；打包时复制到应用资源 `document-fonts` 中。

Mac 原生 LibreOffice 需要 CoreText 用户字体注册。首次 Word 转换把校验后的字体与许可证放入个人目录 `~/Library/Fonts/PaseoEnhanced`，再通过随包编译的 CoreText 助手注册，不覆盖其他个人字体。字体会供本机其他应用使用。注册目录与命名使用包内校验值区分版本；卸载应用不会自动注销用户字体。

字体替换只写入每次转换的临时 LibreOffice 配置。包内字体的英文名称统一到对应中文族名称；宋体、黑体、微软雅黑和楷体等原字体缺失时才进行替换。避免本机中文区域设置下 LibreOffice 忽略英文别名。字体清单和替换策略都参与预览缓存键。源 Word 文档和用户的 LibreOffice 配置不改写。

Word 预览仍是 PDF 阅读，不提供文档编辑或字体选择器。手机读取电脑生成并嵌入字体的 PDF，不需要在手机安装这些字体。
