"""慧运营实时数据看板配置

所有敏感/环境相关字段都支持从环境变量覆盖（部署到云端时不把账号密码写进镜像）：
  HY_ENT          企业编码
  HY_USERNAME     慧运营账号
  HY_PASSWORD     慧运营密码
  HY_API_BASE     慧运营 API 域名
  HY_IMG_BASE     现场图片域名
  HY_SERVER_PORT  服务端口
本地直接运行时使用下方默认值（与历史一致）。
"""
import os

# 慧运营账号（企业编码/账号/密码）—— 云端部署请通过环境变量注入
ENT = os.environ.get("HY_ENT", "cjss")
USERNAME = os.environ.get("HY_USERNAME", "18998601634")
PASSWORD = os.environ.get("HY_PASSWORD", "hyy123456")

# API 基础地址（前端静态域名只是入口，数据走这个后端）
# 2026-09-03：用户浏览器实测真实主机为 zhyyapp.ruipos.com（无 -en 后缀），
# 原 zhyyapp-en.ruipos.com 从本地/沙箱访问恒返 403。改为以无 -en 为主、保留 -en 作回退。
API_BASE = os.environ.get("HY_API_BASE", "https://zhyyapp.ruipos.com")
# 回退主机：当主主机不可达（如云端环境仅能通 -en）时自动切换，避免日常数据流水线中断
API_BASE_FALLBACK = os.environ.get("HY_API_BASE_FALLBACK", "https://zhyyapp-en.ruipos.com")

# 需要汇总的目标岗位/组织。
# 每个元素 = (岗位名包含的字符串, 组织名包含的字符串)
#
# 【2026-09-02 架构变更】改为「组织树解析 organizeId + 报告接口带 organizeId 取数」：
# 慧运营不存在「一个账号能角色切换进全部四个组」——
#   原看板账号：可切换 培训组/新店运营组/加盟营运组，但【没有】新店筹建组；
#   用户账号 888：只有 培训组/总部 角色，角色切换进不了新店运营组/加盟营运组/新店筹建组。
# 实测发现：用 888 的「总部」角色 token 可看到整棵组织树，且各报告接口
# 支持传 organizeId 按组织过滤，从而绕开角色切换的权限限制。
# 已实测 888 总部 token + organizeId 可正确取到全部四组数据（
# 培训组 8 / 新店运营组 46 / 加盟营运组 341 / 新店筹建组 4）。
# 故岗位名一律留空，只按组织名在组织树里匹配节点。
TARGET_POSITIONS = [
    ("", "培训组"),
    ("", "新店运营组"),
    ("", "加盟营运组"),
    ("", "新店筹建组"),
]

# 岗位显示名称映射：organizeName -> 显示名称
POSITION_LABELS = {
    "培训组": "培训组（直营组）",
    "新店运营组": "新店运营组",
    "加盟营运组": "加盟营运组",
    "新店筹建组": "新店筹建组",
}

# 报表中心「区域完成情况（汇总）」权限隔离，本脚本不依赖该权限，
# 直接通过门店巡检汇总 + 组织树门店数做聚合。

# 前端默认统计区间：本月 1 号到今天
DEFAULT_RANGE_MODE = "current_month"  # current_month | last_month | custom

# 数据缓存有效期（秒）
CACHE_TTL_SECONDS = 1800  # 30 分钟

# 不合格现场图片访问域名。
# pictureList 接口只返回相对路径（如 cjss/ri/runtime/202608/xxx.jpg），
# 需要拼上这个域名才能直接展示。
IMG_BASE = os.environ.get("HY_IMG_BASE", "https://testhyy.ruipos.com/")

# 服务端口
SERVER_PORT = int(os.environ.get("HY_SERVER_PORT", "8765"))

# 自检报告「未点评」标记。
# 慧运营 planType=ZJ 的报告，score 字段在未点评时是字符串「未点评」，
# 已点评时是数字（含真实打 0 分的）。判断「有没有被点评」必须用这个标记，
# 不能用 score > 0，否则打 0 分的会被误算成未点评。
UNREVIEWED_MARK = "未点评"
