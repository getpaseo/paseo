---
title: 发布插件
description: 准备、发布 Paseo 插件，并把它提交到经过审查的注册表。
nav: 发布
---

# 发布插件 {#publish-a-plugin}

从一个可用的[插件项目](/docs/plugins)开始。准备好它的展示页，把它发布到 npm 或推送到 GitHub，然后提交到注册表。获得批准后，用户可以用 `paseo plugin add owner/slug` 安装经过审查的版本。

1. 准备你的[展示页](#your-listing-page)；对于可视化插件，还要准备一张[界面图片](#icons-and-screenshots)。
2. [发布到 npm](#publish-on-npm)或[通过 Git 分享](#share-through-github-or-git)。
3. [提交到插件注册表](#plugin-registry)。

对于私有插件，请使用[直接从 Git 安装](#share-through-github-or-git)或[私有 npm 包](#private-npm-packages)。

## 你的展示页 {#your-listing-page}

你可以不带 `OVERVIEW.md` 提交；审查者会根据你的 README 和经过验证的行为创建展示页。要自己维护这个页面，请把 `OVERVIEW.md` 放在 `paseo-plugin.json` 旁边，并把它包含在发布的包中。脚手架已经在 `files` 中包含了它。你随包发布的概览会替换审查者编写的页面。

按以下顺序说明这些要点，只在有帮助时使用标题：

1. 插件做什么。
2. 它如何工作（当这一点不明显时）。
3. 设置：设置项、账号、令牌、外部工具、支持的操作系统和 Paseo 版本。
4. 有用的能力、设置项、数据访问、权限和限制。

说明数据会流向哪里，包括发送给 Agent Provider 的提示词和工具结果。本地存储并不意味着数据留在主机上。如果插件在运行时下载或安装软件，请说明它安装什么以及来源，并在下载之前要求用户明确确认。这同样适用于激活和连接测试；用户拒绝时，软件必须保持未安装状态。

使用平实、客观的语言，标题只把首字母大写。省略营销内容、无依据的说法、徽章、更新日志、贡献和许可证章节，以及无助于他人选择插件的实现细节。展示页已经提供了插件的安装说明。

发布校验器会拒绝概览中任何位置出现的 `paseo plugin add`、`npm install` 和 `npm i`，包括开发或设置示例。请为这些命令链接到你的 README。

还要提供一句话的描述：npm 插件使用 `package.json` 的 `description`，Git 插件使用 manifest 的 `description`。缺少描述时，审查者可以在注册表中补上。

### 其他语言 {#other-languages}

展示页以英文和简体中文显示。英文是必需的，翻译是可选的。在 `paseo-plugin.json` 中添加翻译后的 `name` 和 `description`，以语言标签为键：

```json
{
  "id": "review-tools",
  "name": "Review tools",
  "description": "Reviews changes before merge",
  "translations": {
    "zh-CN": { "name": "审查工具", "description": "在合并前审查改动" }
  }
}
```

每个字段都是可选的，缺少的字段会显示英文。注册表在发布插件时检查 `translations`：键必须是除 `en` 之外的标准语言标签，每个值只能设置 `name` 或 `description`，且必须是非空字符串。Paseo 本身不读取 `translations`，因此这里的错误会导致发布失败，而不会影响安装。

要翻译概览，请在 `OVERVIEW.md` 旁边发布一份以语言命名的完整副本，例如 `OVERVIEW.zh-CN.md`。脚手架的 `files` 列表已经包含 `OVERVIEW.*.md`。当标签是语言代码为两个或三个字母、且不是 `en` 的标准语言标签时，注册表会把 `OVERVIEW.<标签>.md` 当作翻译，并忽略 `OVERVIEW.backup.md`、`OVERVIEW.zh-cn.md` 这类其他名称。`OVERVIEW.old.md` 这样的三字母名称会被当作一种语言，因此不要用它命名非翻译文件。使用该语言的读者会看到翻译；其他读者会看到英文概览和一条提示。上面的概览规则同样适用于翻译，因此 `OVERVIEW.md` 变更时请同步更新翻译。审查者可以在注册表中补充或修正翻译。

## 图标和截图 {#icons-and-screenshots}

主题、面板以及其他带可视界面的插件，需要至少一张展示当前界面的图片。请使用示例数据并隐藏隐私信息。只有图标不满足这项要求；没有自己可视界面的插件不需要截图。

发布之前，在 `paseo-plugin.json` 中声明本地图片：

```json
{
  "id": "review-tools",
  "name": "Review tools",
  "description": "Reviews changes before merge",
  "icon": "assets/icon.png",
  "media": ["assets/screenshot.png"],
  "requirements": { "paseo": ">=0.11.0" }
}
```

创建所引用的文件；对于 npm，把 `assets/` 加入 `package.json` 的 `files` 列表。路径相对于 manifest，使用正斜杠，并且必须位于插件目录之内。这些元数据字段需要 Paseo 0.11.0 或更高版本。

| 字段    | 展示行为                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `name`  | 可选的显示名称；默认是把插件 ID 转换成易读形式。                                                                               |
| `icon`  | 可选的、相对于包的 PNG 路径。Provider 注册图标有单独的 [SVG 约定](/docs/plugins/reference#providers)。                         |
| `media` | 相对于包的路径或公开的 HTTPS URL。图片：PNG、JPG、JPEG、WebP 或 GIF。视频：MP4 或 WebM。第一张图片是卡片缩略图；视频作为补充。 |

公开的媒体 URL 需要带有受支持的文件扩展名（不区分大小写），并且必须以对应的图片或视频内容类型返回 HTTP 200。SVG 和没有扩展名的附件 URL 不能作为注册表媒体。

除了声明 `media`，你也可以在提交或审查 PR 中提供合适的公开图片 URL。审查者可以把它们添加到展示页，无需发布新的插件版本。

## 发布到 npm {#publish-on-npm}

### 1. 设置包的标识 {#1-set-package-identity}

使用一个你有发布权限的 npm scope，并通过 `npm login` 登录。在插件目录中，把下面的 `@acme` 和仓库替换为你自己的值：

```bash
npm pkg set name=@acme/paseo-review version=1.0.0
npm pkg delete private
npm pkg set repository.type=git repository.url=git+https://github.com/acme/paseo-review.git
```

当前的注册表工具要求通过 `package.json` 或 npm provenance 提供一个 GitHub 仓库，用来确定 npm 展示页的归属。请把 `repository` 设置为你公开的源码仓库，以便固定版本时可以确定展示页的所有者。provenance 本身是可选的；如果存在，它的仓库必须与包的仓库一致。审查制品时不需要匹配的源码检出。

### 2. 锁定安装的依赖 {#2-lock-installed-dependencies}

把 Paseo 宿主提供的库和仅用于类型的依赖放在 `devDependencies` 中。把其他运行时库加入 `dependencies`。提交到注册表时，每棵安装的依赖树都需要一个锁文件，包含确切的版本、解析来源和完整性校验，传递依赖也不例外。

对于带有运行时依赖的 npm 包，请在不运行生命周期脚本的情况下更新它的锁文件，然后创建可发布的锁文件：

```bash
npm install --package-lock-only --ignore-scripts
npm shrinkwrap
```

`npm shrinkwrap` 会把 `package-lock.json` 转换为 `npm-shrinkwrap.json`。npm 会在包的根目录发布 shrinkwrap 文件，但不会发布 `package-lock.json`。只存在于仓库中的锁文件或确切的直接依赖版本，并不能锁定用户安装的依赖树。

只使用宿主提供的库和开发依赖的插件不需要运行时锁文件，除非某个准备命令会安装这些依赖。你也可以把库打包进插件，并移除运行时依赖声明。如果你的插件会安装一棵单独的依赖树，请参阅[准备与额外设置](#plugins-with-a-build-step)。

### 3. 检查包并发布 {#3-check-the-package-and-publish}

在检查包之前生成所有需要的文件；dry run 会跳过打包脚本。

```bash
npm run typecheck
npm pack --dry-run --ignore-scripts
```

检查文件列表是否包含 `paseo-plugin.json`、至少一个运行时入口、每个被导入的本地模块、你声明的所有概览和资源文件，以及需要时的 shrinkwrap 文件。只在仓库中存在的导入别名和包外的文件不会到达用户手中。脚手架已经包含了入口以及 `client/`、`server/` 和 `shared/`；请把其他资源目录加入 `files`。

确认所有声明的准备命令在你支持的 Node/npm 版本下都能成功；不同步或不兼容的锁文件仍然会阻止安装。

发布检查过的版本：

```bash
npm publish --access public
```

在测试用的 daemon 上，安装这个确切的已发布版本，并试用它的各项贡献：

```bash
paseo plugin install npm:@acme/paseo-review@1.0.0
paseo plugin ls
```

确认状态为 `running` 且没有错误，然后[提交这个包](#plugin-registry)。

## 通过 GitHub 或 Git 分享 {#share-through-github-or-git}

对于公开注册表，请把插件推送到一个公开的 GitHub 仓库。包含它的 manifest、运行时入口、被导入的文件和展示页资源。提交时 Git 标签和提交是可选的；提供一个即可选择某个修订，否则审查者会解析 `main`。

如果准备过程会安装运行时 npm 依赖，请提交一个同步的 `package-lock.json`，并把以下命令加入 `paseo-plugin.json`：

```json
{
  "build": [["npm", "ci", "--omit=dev", "--ignore-scripts"]]
}
```

`npm ci` 使用已提交的锁文件，如果它与 `package.json` 不一致就会失败。`--omit=dev` 排除开发工具，`--ignore-scripts` 禁止依赖的生命周期脚本。daemon 的命令路径中需要有 npm。只使用宿主提供的库的插件不需要准备命令。生成文件或显式脚本见[准备](#plugins-with-a-build-step)。

用户可以不经注册表展示页，直接从 Git 安装：

```bash
paseo plugin add git:acme/paseo-review
paseo plugin add git:acme/monorepo:plugins/review
```

使用 `--ref` 为首次安装选择分支、标签或提交。只要 daemon 有访问权限，直接安装也支持私有仓库和其他 Git 托管平台；见[插件来源](/docs/plugins/reference#plugin-sources)。注册表提交接受公开的 GitHub 来源和公开的 npm 包。

## 插件注册表 {#plugin-registry}

打开[提交表单](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml)。请使用该表单，这样 issue 才会获得启动收录流程的提交标签。

1. 用插件的名称作为标题。
2. 在 **Source** 中填写公开的 npm 包名或页面，或 GitHub 仓库/文件夹的 URL。如果你希望审查某个特定版本，请附上版本号或 Git 引用。npm 默认使用 `latest`。注册表 ID 和本地目录不能作为提交来源。
3. 选择合适的分类。把所有界面图片的 URL 写在 issue 描述中。

机器人会打开一个审查 PR。审查者在不运行插件代码的情况下检查制品和依赖，完善展示页，并记录被批准的确切版本或提交。发布需要符合[审查政策](https://github.com/getpaseo/plugins/blob/main/REVIEW.md)，包括锁定的安装输入和恰当的数据访问，即使自动校验已经通过。

如果被要求修改，请在审查 PR 中回复修正后的版本或修订，或所要求的图片 URL。审查者会更新固定的版本和展示页。收录服务的错误会自动重试；缺少图片或概览不会妨碍打开审查 PR。

获得批准并发布后，用户可以这样安装你的插件：

```bash
paseo plugin add owner/slug
```

npm 发布会自动收到更新 PR。Git 更新需要手动提交所需的修订。已有的注册表安装使用被批准的固定版本；直接通过 npm/Git 安装的插件遵循[来源参考](/docs/plugins/reference#plugin-sources)中各自的更新规则。

## 带构建步骤的插件 {#plugins-with-a-build-step}

Paseo 会编译 TypeScript，因此普通插件不需要单独的发布构建。请把生成的模块放在它们的运行时目录中，并把宿主提供的模块保留为外部依赖。

Paseo 在获取包时会禁止 npm 生命周期脚本。manifest 的 `build` 中显式声明的命令仍然会运行，包括它们调用的脚本。请说明这些命令的用途，并让它们的输入保持锁定且可检查。当 npm 已经安装了生产依赖时，请从 npm manifest 中移除只用于 Git 的依赖安装命令。

之后安装另一棵依赖树的设置步骤需要它自己的完整锁文件，即使你的插件已经有一个开发用的锁文件。对于 npm 设置，请把运行时 manifest 和锁文件一起发布，并使用 `npm ci`。对于 Python 设置，请发布一个 requirements 文件，其中包含所有传递依赖包的确切版本和 SHA-256 哈希，然后这样安装：

```bash
python -m pip install --require-hashes -r requirements-documents.txt
```

该命令会拒绝未固定版本或没有哈希的依赖。运行时安装还需要满足上文所述的[确认和披露](#your-listing-page)要求。

## 私有 npm 包 {#private-npm-packages}

:::example[用 GitHub Packages 发布私有包 {#publish-a-private-package-with-github-packages}]

你可以把公司内部的插件发布到 GitHub Packages。按照上面的 npm 步骤操作，使用你组织的 scope，并把发布命令替换为：

```bash
npm publish --registry=https://npm.pkg.github.com
```

发布之前，请先[配置 GitHub 身份验证和包访问权限](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)。

要安装插件，请**在 daemon 主机上，以运行 Paseo 的用户身份**配置 npm：

1. 把你组织的注册表加入 `~/.npmrc`：

   ```ini
   @acme:registry=https://npm.pkg.github.com
   ```

2. 用你的 GitHub 用户名登录，并以一个 personal access token (classic) 作为密码。该令牌需要 `read:packages` 以及对该包的访问权限。

   ```bash
   npm login --scope=@acme --auth-type=legacy --registry=https://npm.pkg.github.com
   ```

3. 安装插件：

   ```bash
   paseo plugin install npm:@acme/paseo-review
   ```

Paseo 在安装和更新时使用主机的 npm 注册表设置和凭据。在应用中，只需输入来源标识符。

:::
