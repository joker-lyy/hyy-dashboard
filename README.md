# 苍井寿司 · 慧运营巡检看板（GitHub Pages 静态版）

零服务器、零费用的巡检看板。数据由 GitHub Actions 定时拉取并生成静态 JSON，
前端直接读取，**不需要任何后端**（已下线腾讯云 SCF）。

## 架构

```
GitHub Actions（定时跑 Python 拉慧运营数据）
        │ 每天 1 次（北京时间 00:05，电脑关机也照常运行）
        ▼
  data/*.json（静态快照，提交进仓库）
        │
        ▼
GitHub Pages（index.html + app.js + data/*.json）
        │
        ▼
   浏览器直接打开，秒开
```

## 目录结构

```
index.html                     前端页面
app.js                         前端逻辑（读静态 JSON，无后端调用）
data/                          Actions 生成的静态数据（必须提交）
  ├─ data.json                 主看板数据
  ├─ unqualified.json          不合格明细
  ├─ trends_{period}_{group}.json    自检趋势（4×2=8 个）
  ├─ rankings_{type}_{period}.json   区域排名（4×4=16 个）
  └─ meta.json                 本次生成元信息
scripts/
  ├─ fetch_data.py             拉数并生成上述 JSON
  ├─ server.py / hhy_api.py / hhy_config.py    慧运营接口封装（已去除 Flask 依赖）
  └─ requirements.txt          仅 requests
.github/workflows/update-data.yml    定时拉取 + 自动提交
```

## 首次部署（约 10 分钟）

### 1. 创建仓库

GitHub 网页 → New repository：

- Repository name：随意，如 `hyy-dashboard`
- Visibility：**Public**（GitHub Free 只有公开仓库才能用 Pages，且 Actions 分钟数无限）
- 勾选 Add a README 可留空（本文件已存在）

### 2. 推送代码

```bash
cd gh_pages
git init -b main
git add -A
git commit -m "feat: 慧运营巡检看板静态版"
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

### 3. 配置慧运营账号（Secrets）

仓库页面 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，
逐个添加：

| Name | Value |
|------|-------|
| `HY_ENT` | `cjss` |
| `HY_USERNAME` | `18998601634` |
| `HY_PASSWORD` | 慧运营密码 |
| `HY_API_BASE` | `https://zhyyapp-en.ruipos.com` |
| `HY_IMG_BASE` | `https://testhyy.ruipos.com/` |

密码存在 Secrets 里，日志会自动打码，别人看不到。

### 4. 开启 GitHub Pages

**Settings** → **Pages** → Build and deployment：

- Source：**Deploy from a branch**
- Branch：**main** / **/ (root)** → Save

等 1~2 分钟，页面顶部会给出访问地址：
`https://<用户名>.github.io/<仓库名>/`

### 5. 触发首次拉数

**Actions** 标签页 → 左侧选「拉取慧运营数据」→ 右侧 **Run workflow** → 选 main 分支 → 运行。

首次约 30~40 分钟（慧运营接口较慢）。跑完后刷新页面即可看到数据。

## 数据脱敏（重要，部署前请确认）

仓库是**公开的**（GitHub Free 只有公开仓库能用 Pages），所以数据会被全网看到。
脚本默认做了一层脱敏，但**并非全部**，请确认你能接受：

### ✅ 已自动脱敏（默认开启）

| 字段 | 说明 | 处理 |
|------|------|------|
| `franchiseeName` | 加盟商姓名（约 238 条） | 替换为 `***` |
| `phone` / `mobile` / `tel` / `idcard` | 电话、身份证 | 替换为 `***` |

### ⚠️ 仍然公开的内容（业务必需，未脱敏）

| 内容 | 样例 | 说明 |
|------|------|------|
| 门店名 | 中山康华店、中山南朗店 | 看板的核心价值：定位到具体门店去整改 |
| **区域名（含督导真名）** | 付鹏区域、刘浩区域、吴纯锋区域、谢艺坤区域、赖先晓区域 | 按区域排名/整改必需 |
| 各门店得分、不合格项、排名 | — | 看板主体数据 |

**区域名里的督导真名是主要遗留风险。** 如果需要一并脱敏，在
`scripts/fetch_data.py` 里给 `region` 加映射（如 `陈秀金区域 → R03`），
但这样区域排名会变成看不懂的编码，需要你自己记对照表。

### 关闭脱敏

改用私有仓库后（需 GitHub Pro），在 Actions 环境变量设 `ANONYMIZE=0` 即可输出完整数据。

## 修改数据区间

默认统计区间是**当年 7 月 1 日 ~ 今天**。在页面上改日期不会重新拉数（静态版限制），
会弹窗提示。要改区间请编辑 `scripts/fetch_data.py` 顶部的：

```python
DEFAULT_START_MONTH = 7
DEFAULT_START_DAY = 1
```

然后推送，Actions 会自动重跑。

## 修改刷新频率

编辑 `.github/workflows/update-data.yml` 的 cron（按 UTC 写入，北京时间 = UTC+8）：

```yaml
schedule:
  - cron: "5 16 * * *"   # 北京时间每天 00:05（UTC 前一天 16:05），每天 1 次
```

公开仓库 Actions 分钟数无限，可以放心加密。

## 本地生成数据（调试用）

```bash
export HY_ENT=cjss
export HY_USERNAME=18998601634
export HY_PASSWORD=你的密码
python scripts/fetch_data.py
```

只依赖 `requests`，不需要 Flask。

## 与腾讯云版本的区别

| | 腾讯云 SCF 版 | GitHub Pages 版 |
|---|---|---|
| 费用 | 按量付费 | **完全免费** |
| 后端 | Flask 常驻实例 | **无后端** |
| 首屏 | 冷启动 30s+ | **秒开（读静态 JSON）** |
| 数据实时性 | 实时 | 定时（默认每天 1 次：北京时间 00:05） |
| 改日期区间 | 支持任意区间 | **固定区间**（构建期生成） |
| 不合格项照片下钻 | 支持 | 暂不支持（静态版无法枚举） |
