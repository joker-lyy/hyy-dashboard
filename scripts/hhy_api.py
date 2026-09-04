"""慧运营 HTTP API 直连封装（数据看板专用）"""
import datetime
import hashlib
import json
import random
import string
import time
from typing import Any, Dict, List, Optional
import requests

import hhy_config as cfg

# 记录最近一次登录所在的灰度/生产环境，用于生成正确的前端报告链接
_last_is_grey: Optional[bool] = None

# 当前生效的组织 ID。由 switch_position_and_login 解析组织树后设置，
# 各报告接口会自动带上它作为 organizeId 参数按组织过滤。
#
# 背景：慧运营的账号「角色切换」权限与「组织树可见性」是两回事。
# 看板账号能角色切换进 培训组/新店运营组/加盟营运组，但切不进新店筹建组；
# 而 888 账号虽只有 培训组/总部 角色，其「总部」token 却能看到整棵组织树。
# 因此改为：用总部 token 取数，并显式把 organizeId 传给各报告接口按组织过滤，
# 从而绕开角色切换限制，一个账号即可抓全四组。
_active_org_id = None


def _oid(organize_id=None):
    """取生效的 organizeId：显式传入优先，否则用当前组织上下文。"""
    return organize_id if organize_id is not None else _active_org_id


def web_base() -> str:
    """根据最近一次登录的 isGrey 返回对应前端域名。"""
    if _last_is_grey is True:
        return "https://hyygray.ruipos.com"
    return "https://zhyy.ruipos.com"


def _nonce(n: int = 16) -> str:
    return "".join(random.choices(string.ascii_letters + string.digits, k=n))


def _sign(nonce: str, timestamp: str) -> str:
    # sign = SHA256(nonce + timestamp_ms + "hyy&&123456")
    return hashlib.sha256(f"{nonce}{timestamp}hyy&&123456".encode()).hexdigest()


def _headers(token: str = "") -> Dict[str, str]:
    h = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "ent": cfg.ENT,
        "Origin": "https://zhyy.ruipos.com",
        "Referer": "https://zhyy.ruipos.com/",
    }
    if token:
        h["token"] = token
    return h


def login(role: Optional[int] = None, organize_id: Optional[int] = None) -> Dict[str, Any]:
    """登录，返回完整响应 data（含 token）。role/organize_id 必须为整数。"""
    nonce = _nonce()
    timestamp = int(time.time() * 1000)
    body = {
        "sign": _sign(nonce, str(timestamp)),
        "nonce": nonce,
        "timestamp": timestamp,
        "phoneModel": "Mozilla/5.0",
        "platform": "browser",
        "clientVersion": "4.0.0",
        "loginType": "W",
        "ent": cfg.ENT,
        "username": cfg.USERNAME,
        "password": cfg.PASSWORD,
    }
    if role is not None:
        body["role"] = int(role)
    if organize_id is not None:
        body["organizeId"] = int(organize_id)

    last = None
    for h in _hosts():
        try:
            url = f"{h}/auth/login?version=1"
            resp = requests.post(url, json=body, headers=_headers(), timeout=30)
            resp.raise_for_status()
            data = resp.json()
            break
        except requests.exceptions.RequestException as e:
            last = e
            continue
    else:
        raise last or RuntimeError("登录：所有 API 主机均不可达")
    ok = (data.get("code") == 200 or data.get("status") == 0)
    if not ok or not data.get("data", {}).get("token"):
        raise RuntimeError(f"登录失败: {data}")
    global _last_is_grey
    _last_is_grey = bool(data["data"].get("isGrey"))
    return data["data"]


def list_positions(token: str) -> List[Dict[str, Any]]:
    """列出当前账号全部岗位"""
    url = f"{cfg.API_BASE}/web/md/my/webFindMyOrganizeRole?version=1"
    resp = requests.post(url, json={}, headers=_headers(token), timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != 200 and data.get("status") != 0:
        raise RuntimeError(f"获取岗位失败: {data}")
    return data.get("data", [])


def org_tree(token: str, parent_id: str = "", _retried: bool = False) -> List[Dict[str, Any]]:
    """
    获取组织树（受当前 token 岗位权限限制）。
    fix26：token 过期（status=10006「账号异常，请重新登录」）时自动重新登录一次再重试。
    _retried=True 表示已经重试过，不再二次登录（防登录死循环触发风控）。
    """
    url = f"{cfg.API_BASE}/web/md/org/tree?version=1"
    resp = requests.post(url, json={"parentId": parent_id}, headers=_headers(token), timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if _is_token_expired(data):
        if _retried:
            raise RuntimeError(f"获取组织树失败(重登录后仍过期): {data}")
        new_token, _ = _tree_session(force=True)
        return org_tree(new_token, parent_id=parent_id, _retried=True)
    if data.get("code") != 200 and data.get("status") != 0:
        raise RuntimeError(f"获取组织树失败: {data}")
    return data.get("data", [])


def all_org_info(token: str) -> Dict[str, Any]:
    """取组织层级信息（含 maxHighNo）"""
    url = f"{cfg.API_BASE}/web/md/org/allOrgInfo?version=1"
    resp = requests.post(url, json={}, headers=_headers(token), timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != 200 and data.get("status") != 0:
        raise RuntimeError(f"获取组织信息失败: {data}")
    return data.get("data", {})


def _is_token_expired(data: Any) -> bool:
    """慧运营 token 过期会返回 status=10006「账号异常，请重新登录」。"""
    if not isinstance(data, dict):
        return False
    return data.get("status") == 10006 or "重新登录" in str(data.get("message") or "")


def _hosts() -> List[str]:
    """API 主机优先级：主主机（zhyyapp.ruipos.com）→ 回退主机（-en）。"""
    hs = [cfg.API_BASE]
    fb = getattr(cfg, "API_BASE_FALLBACK", "")
    if fb and fb not in hs:
        hs.append(fb)
    return hs


def _req_fallback(path: str, fire) -> Any:
    """按 _hosts 顺序尝试发请求；连接/HTTP 错误（含 403）回退，业务错误（code!=200）不回退。"""
    last = None
    for h in _hosts():
        try:
            return fire(f"{h}{path}")
        except requests.exceptions.RequestException as e:
            last = e
            print(f"[host-fallback] {h} 不可达，回退下一主机: {str(e)[:80]}")
            continue
    raise last or RuntimeError(f"所有 API 主机均不可达: {path}")


def post_json(token: str, path: str, body: Dict[str, Any]) -> Any:
    """通用 JSON POST（token 过期时自动重新登录并重试一次）"""
    def fire(url):
        resp = requests.post(url, json=body, headers=_headers(token), timeout=60)
        resp.raise_for_status()
        data = resp.json()
        if _is_token_expired(data):
            try:
                new_token, _ = _tree_session(force=True)
                resp = requests.post(url, json=body, headers=_headers(new_token), timeout=60)
                resp.raise_for_status()
                data = resp.json()
            except Exception as e:
                print(f"[WARN] token 过期后重登重试失败（{path}）：{e}")
        if data.get("code") != 200 and data.get("status") != 0:
            raise RuntimeError(f"请求 {path} 失败: {data}")
        return data.get("data")
    return _req_fallback(path, fire)


def post_form(token: str, path: str, body: Dict[str, Any]) -> Any:
    """通用 form-urlencoded POST（慧运营多数列表接口必须用这个格式，否则分页失效）"""
    def fire(url):
        resp = requests.post(url, data={"data": json.dumps(body)}, headers=_headers(token), timeout=60)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 200 and data.get("status") != 0:
            raise RuntimeError(f"请求 {path} 失败: {data}")
        return data.get("data")
    return _req_fallback(path, fire)


def post_query(token: str, path: str, params: Dict[str, Any]) -> Any:
    """
    通用「URL query 参数 + form-urlencoded 空 body」POST。

    慧运营有两类接口，参数位置不同，混用会静默失效：
      - 一类把参数放在 JSON body（如 /web/ri/report/list）
      - 另一类把参数放在 URL query，且 Content-Type 必须是
        application/x-www-form-urlencoded（如 /web/ri/cg/stat/storeInspectionReport）。
        若把 pageNumber/pageSize 放进 body，后端会忽略并退回默认 pageSize=20，
        表现为「接口永远只返回 20 行」，很容易被误判成后端硬限制。
    """
    def fire(url):
        headers = dict(_headers(token))
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        resp = requests.post(url, params=params, data={}, headers=headers, timeout=90)
        resp.raise_for_status()
        data = resp.json()
        if _is_token_expired(data):
            try:
                new_token, _ = _tree_session(force=True)
                headers = dict(_headers(new_token))
                headers["Content-Type"] = "application/x-www-form-urlencoded"
                resp = requests.post(url, params=params, data={}, headers=headers, timeout=90)
                resp.raise_for_status()
                data = resp.json()
            except Exception as e:
                print(f"[WARN] token 过期后重登重试失败（{path}）：{e}")
        if data.get("code") != 200 and data.get("status") != 0:
            raise RuntimeError(f"请求 {path} 失败: {data}")
        return data.get("data")
    return _req_fallback(path, fire)


def fetch_store_inspection_report(token: str, start_date: str, end_date: str,
                                  organize_id: Any = None) -> List[Dict[str, Any]]:
    """
    门店巡检汇总（常规巡检报告 / storeInspectionReport）。

    organize_id：按组织过滤。留空时自动取当前组织上下文
    （由 switch_position_and_login 设置），实现「按组取数」。
    """
    oid = _oid(organize_id)
    path = "/web/ri/cg/stat/storeInspectionReport?version=1"
    page_size = 500
    page_number = 1
    all_rows = []
    seen_store_codes = set()
    while True:
        params = {
            "startDate": start_date,
            "endDate": end_date,
            "pageNumber": page_number,
            "pageSize": page_size,
        }
        if oid is not None:
            params["organizeId"] = int(oid)
        data = post_query(token, path, params)
        if isinstance(data, list):
            rows = data
            total = len(rows)
        else:
            rows = data.get("list", []) if data else []
            total = data.get("totalRow", 0) if data else 0
        new_count = 0
        for row in rows:
            sc = row.get("storeCode")
            if sc in seen_store_codes:
                continue
            seen_store_codes.add(sc)
            all_rows.append(row)
            new_count += 1
        if not rows or new_count == 0:
            break
        if total and len(all_rows) >= total:
            break
        if len(rows) < page_size:
            break
        page_number += 1
        if page_number > 200:
            break
    return all_rows


def fetch_store_rectification_summary(token: str, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """
    门店整改汇总（慧运营「整改中心 → 门店整改汇总」同款接口）。

    这是唯一能给出门店维度「不合格项数」的权威接口，按门店返回：
      organizeName(门店名) / orgName(组织路径) / sumNum(整改项总数=不合格项数) /
      yzg(已整改) / dzg(待整改) / dsh(待审核) / yqzs(逾期总数) / zglv(整改率)
    注意走 /statRi 前缀且用 JSON body。
    """
    path = "/statRi/web/ri/item/storeRectificationSummary?version=1"
    oid = _oid(None)  # 当前组织上下文：由 switch_position_and_login 设置
    all_rows = []
    page_number = 1
    while True:
        body = {
            "startDate": start_date,
            "endDate": end_date,
            "pageNumber": page_number,
            "pageSize": 500,
        }
        if oid is not None:
            body["organizeId"] = int(oid)
        data = post_json(token, path, body)
        rows = data if isinstance(data, list) else ((data or {}).get("list", []) if data else [])
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < 500:
            break
        page_number += 1
        if page_number > 50:
            break
    return all_rows


def fetch_sp_store_inspection_report(token: str, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """
    视频稽核门店巡检汇总（/statRi/web/ri/sp/stat/storeInspectionReport）。
    参数同样走 URL query。返回 reportCount / isPassCount / xuCorrectedReport /
    isCorrectedCount / expiredCorrectReport / avgScore / bhgRate 等。
    """
    path = "/statRi/web/ri/sp/stat/storeInspectionReport?version=1"
    oid = _oid(None)  # 当前组织上下文：由 switch_position_and_login 设置
    all_rows = []
    seen = set()
    page_number = 1
    while True:
        params = {
            "startDate": start_date,
            "endDate": end_date,
            "pageNumber": page_number,
            "pageSize": 500,
        }
        if oid is not None:
            params["organizeId"] = int(oid)
        data = post_query(token, path, params)
        rows = data if isinstance(data, list) else ((data or {}).get("list", []) if data else [])
        if not rows:
            break
        new = 0
        for r in rows:
            sc = r.get("storeCode") or r.get("fullName")
            if sc in seen:
                continue
            seen.add(sc)
            all_rows.append(r)
            new += 1
        if new == 0 or len(rows) < 500:
            break
        page_number += 1
        if page_number > 200:
            break
    return all_rows


def fetch_sp_category_unqualified_info(token: str, start_date: str, end_date: str,
                                       max_high_no: int = 4) -> List[Dict[str, Any]]:
    """
    视频稽核问题项明细（/statRi/web/ri/sp/stat/categoryUnqualifiedInfo）。
    用于「视频巡检 → 按问题分类」与首页视频高发问题卡片。
    返回行含：title(巡检项名称) / categoryName / bxjcs(被巡检次数) /
              bxjcsBhg(不合格次数) / bxjmds(被巡检门店数) / bxjmdsBhg(不合格门店数) /
              isOkItmeContentCount(合格项数) / xjzf / bxjzf / zgwccl 等。
    """
    path = "/statRi/web/ri/sp/stat/categoryUnqualifiedInfo?version=1"
    oid = _oid(None)  # 当前组织上下文
    body = {
        "startDate": start_date,
        "endDate": end_date,
        "organizeHighNo": int(max_high_no),
        "categoryHighNo": 2,
        "pageNumber": 1,
        "pageSize": 500,
    }
    if oid is not None:
        body["organizeId"] = int(oid)
    data = post_json(token, path, body)
    if isinstance(data, list):
        return data
    return (data or {}).get("list", []) if data else []


def fetch_category_unqualified_total(token: str, start_date: str, end_date: str,
                                     max_high_no: int = 4) -> List[Dict[str, Any]]:
    """
    品类不合格汇总 Top。需要同时传 organizeHighNo 与 categoryHighNo（传 2 级类目）。
    返回原始行，由上层按 categoryName 聚合。
    """
    path = "/web/ri/cg/stat/categoryUnqualifiedTotal?version=1"
    oid = _oid(None)  # 当前组织上下文
    body = {
        "startDate": start_date,
        "endDate": end_date,
        "organizeHighNo": int(max_high_no),
        "categoryHighNo": 2,
    }
    if oid is not None:
        body["organizeId"] = int(oid)
    data = post_json(token, path, body)
    if isinstance(data, list):
        return data
    return data.get("list", []) if data else []


def fetch_video_inspection_reports(token: str, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """
    视频稽核报告列表。
    接口路径：慧运营 -> 层级检核 -> 稽核巡检 -> 视频稽核 -> 视频稽核报告。
    请求路径：/web/ri/video/list?version=1，必传 startDate / endDate / pageNumber / pageSize。
    返回行含 reportId / fullName / storeCode / nameLink / score / isPass / unRectifyNum /
              isCorrected / isExpiredCorrect / reportDate / templateName 等。
    """
    path = "/web/ri/video/list?version=1"
    oid = _oid(None)  # 当前组织上下文：由 switch_position_and_login 设置
    page_size = 300
    page_number = 1
    all_rows = []
    seen = set()
    while True:
        body = {
            "pageNumber": page_number,
            "pageSize": page_size,
            "startDate": start_date,
            "endDate": end_date,
        }
        if oid is not None:
            body["organizeId"] = int(oid)
        data = post_json(token, path, body)
        if isinstance(data, list):
            rows = data
        elif isinstance(data, dict):
            rows = data.get("list") or data.get("records") or data.get("rows") or []
        else:
            rows = []
        if not rows:
            break
        for r in rows:
            rid = r.get("reportId")
            if rid in seen:
                continue
            seen.add(rid)
            all_rows.append(r)
        if len(rows) < page_size:
            break
        page_number += 1
        if page_number > 100:
            break
    return all_rows


def fetch_self_inspection_reports(token: str, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """
    拉取自检(planType=ZJ)报告列表，自动分页，返回所有报告行。
    每行含：reportId, fullName, storeCode, nameLink, templateName（开店检查/打烊检查）,
           correctedStatus, expiredStatus, isPass, isPassString, reportDate 等。
    """
    return _fetch_report_list(token, start_date, end_date, "ZJ")

def fetch_ai_reports(token: str, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """
    AI 慧检报告列表（fix54）。
    接口路径：慧运营 -> 层级检核 -> AI慧检 -> AI稽核报告。
    实测请求路径：/statRi/web/ai/audit/report/page/list?ent=cjss&version=1
    返回行通常含 reportId / fullName / storeCode / nameLink / score / reportDate 等
    （具体字段以云端真实返回为准，聚合处做了多候选兜底）。
    """
    path = "/statRi/web/ai/audit/report/page/list?ent=cjss&version=1"
    oid = _oid(None)
    page_size = 300
    page_number = 1
    all_rows = []
    seen = set()
    while True:
        body = {
            "pageNumber": page_number,
            "pageSize": page_size,
            "startDate": start_date,
            "endDate": end_date,
        }
        if oid is not None:
            body["organizeId"] = int(oid)
        data = post_json(token, path, body)
        if isinstance(data, list):
            rows = data
        elif isinstance(data, dict):
            rows = data.get("list") or data.get("records") or data.get("rows") or []
        else:
            rows = []
        if not rows:
            break
        for r in rows:
            rid = r.get("reportId") or r.get("id")
            if rid in seen:
                continue
            seen.add(rid)
            all_rows.append(r)
        if len(rows) < page_size:
            break
        page_number += 1
        if page_number > 100:
            break
    return all_rows


def fetch_rectifications(token: str, report_id: Any = None, plan_type: str = None,
                         start_date: str = None, end_date: str = None) -> List[Dict[str, Any]]:
    """
    拉取整改单列表（fix53 弹窗整合整改单）。
    接口路径（用户实测）：/web/ri/item/rectificationRecord?version=1
    整改单是「所有报告类型共用」一个接口；可按 reportId 过滤某份报告的关联整改单，
    也可只传 planType/日期拉全局。返回行含 description/checkPoint/relInspectItem/status/source/report 等。
    """
    path = "/web/ri/item/rectificationRecord?version=1"
    oid = _oid(None)
    page_size = 300
    page_number = 1
    all_rows = []
    seen = set()
    while True:
        body = {
            "pageNumber": page_number,
            "pageSize": page_size,
        }
        if report_id is not None:
            body["reportId"] = str(report_id)
        if plan_type:
            body["planType"] = str(plan_type)
        if oid is not None:
            body["organizeId"] = int(oid)
        if start_date:
            body["startDate"] = start_date
        if end_date:
            body["endDate"] = end_date
        data = post_json(token, path, body)
        if isinstance(data, list):
            rows = data
        elif isinstance(data, dict):
            rows = data.get("list") or data.get("records") or data.get("rows") or []
        else:
            rows = []
        if not rows:
            break
        for r in rows:
            rid = r.get("rectifyId") or r.get("id") or r.get("reportId")
            if rid in seen:
                continue
            seen.add(rid)
            all_rows.append(r)
        if len(rows) < page_size:
            break
        page_number += 1
        if page_number > 100:
            break
    return all_rows


def fetch_cg_reports(token: str, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """
    拉取常规巡检(planType=CG)报告列表，自动分页。
    每行含 reportId、signId、storeCode、fullName、score、reportDate 等，
    可用于构造慧运营报告详情页跳转链接。
    """
    return _fetch_report_list(token, start_date, end_date, "CG")


def _fetch_report_list(token: str, start_date: str, end_date: str, plan_type: str) -> List[Dict[str, Any]]:
    """通用 report/list 拉取，按 reportId 去重。"""
    path = "/web/ri/report/list?version=1"
    oid = _oid(None)  # 当前组织上下文：由 switch_position_and_login 设置
    page_size = 300
    page_number = 1
    all_rows = []
    seen = set()
    while True:
        body = {
            "planType": plan_type,
            "pageNumber": page_number,
            "pageSize": page_size,
            "startDate": start_date,
            "endDate": end_date,
        }
        if oid is not None:
            body["organizeId"] = int(oid)
        data = post_json(token, path, body)
        if isinstance(data, list):
            rows = data
        elif isinstance(data, dict):
            rows = data.get("list") or data.get("records") or data.get("rows") or []
        else:
            rows = []
        if not rows:
            break
        for r in rows:
            rid = r.get("reportId")
            if rid in seen:
                continue
            seen.add(rid)
            all_rows.append(r)
        if len(rows) < page_size:
            break
        page_number += 1
        if page_number > 100:
            break
    return all_rows


def fetch_report_detail(token: str, report_id: Any, plan_type: str,
                        sign_id: Any = None, organize_id: Any = None) -> Optional[Dict[str, Any]]:
    """
    拉取单份报告明细（分类/检查项/得分/照片/整改）。

    慧运营不同 planType 的「报告详情」接口路径不一致，且参数位置（body / query）混用，
    故对每个 planType 准备多个候选接口，逐个尝试，返回首个返回非空 data 的；
    并把命中的 endpoint 一并返回，便于在云端运行日志里确认哪个接口可用。

    已知可用（用户实测）：ZJ → /web/ri/report/info?planType=ZJ
    CG / SP 的明细接口路径待云端运行实测确认（这里多候选兜底）。

    fix61：把 String() 改成 str()（Python 没有 String 这个名字），
           并给每个候选打详细日志（code/data/响应片段），便于排查「为何候选全失败」。
    """
    pt = str(plan_type or "CG").upper()
    rid = report_id
    oid = _oid(organize_id)
    # 候选：(path, body_dict, use_query_bool)
    if pt == "ZJ":
        cands = [
            ("/web/ri/report/info?version=1", {"reportId": rid, "planType": "ZJ"}, False),
            ("/web/ri/zj/report/info?version=1", {"reportId": rid}, False),
            ("/web/ri/zj/report/detail?version=1", {"reportId": rid}, False),
        ]
    elif pt == "CG":
        sid = sign_id or rid
        cands = [
            ("/web/ri/report/info?version=1", {"reportId": rid, "planType": "CG", "signId": sid}, False),
            ("/web/ri/cg/report/info?version=1", {"reportId": rid, "signId": sid}, False),
            ("/web/ri/cg/report/info?version=1", {"reportId": rid, "signId": sid}, True),
            ("/web/ri/cg/report/detail?version=1", {"reportId": rid, "signId": sid}, False),
            ("/statRi/web/ri/cg/report/info?version=1", {"reportId": rid, "signId": sid}, False),
        ]
    elif pt in ("SP", "VIDEO"):
        cands = [
            ("/web/ri/report/info?version=1", {"reportId": rid, "planType": "SP"}, False),
            ("/web/ri/sp/report/info?version=1", {"reportId": rid}, False),
            ("/web/ri/sp/report/detail?version=1", {"reportId": rid}, False),
            ("/web/ri/video/report/info?version=1", {"reportId": rid}, False),
            ("/statRi/web/ri/sp/report/info?version=1", {"reportId": rid}, False),
        ]
    elif pt == "AI":
        # 用户实测：AI 慧检明细在 /statRi/web/ai/audit/report/detail?ent=cjss
        cands = [
            ("/statRi/web/ai/audit/report/detail?ent=cjss&version=1", {"reportId": rid}, False),
            ("/statRi/web/ai/audit/report/detail?ent=cjss&version=1", {"id": rid}, False),
            ("/statRi/web/ai/audit/report/info?ent=cjss&version=1", {"reportId": rid}, False),
        ]
    else:
        cands = [("/web/ri/report/info?version=1", {"reportId": rid, "planType": pt}, False)]

    last_resp_snippet = ""
    for idx, (path, body, use_query) in enumerate(cands, 1):
        b = dict(body)
        if oid is not None:
            b["organizeId"] = int(oid)
        try:
            data = post_query(token, path, b) if use_query else post_json(token, path, b)
        except Exception as e:
            print(f"[report-detail] {pt} cand#{idx} {path} 抛异常: {str(e)[:140]}")
            last_resp_snippet = f"exc:{str(e)[:60]}"
            continue
        # fix61：详细日志，便于排查"为何每个候选都返回空"
        snippet = json.dumps(data, ensure_ascii=False)[:120] if data else "(空)"
        print(f"[report-detail] {pt} cand#{idx} {path} ok data={snippet}")
        last_resp_snippet = snippet
        if data:
            # 过滤空壳响应（部分接口返回 code=200 但 data 为空 dict/空列表）
            if isinstance(data, dict) and not data:
                continue
            if isinstance(data, list) and not data:
                continue
            return {"endpoint": path, "planType": pt, "raw": data, "candIdx": idx}
    print(f"[report-detail] {pt} {rid} 所有候选失败，最后响应: {last_resp_snippet[:100]}")
    return None


def fetch_zj_category_unqualified_total(token: str, start_date: str, end_date: str,
                                        max_high_no: int, organize_id: Any) -> List[Dict[str, Any]]:
    """
    每日自检（planType=ZJ）品类不合格汇总。
    需要传 repeatModel='R'（每日重复）和 organizeId。
    """
    path = "/web/ri/zj/stat/categoryUnqualifiedTotal?version=1"
    body = {
        "startDate": start_date,
        "endDate": end_date,
        "organizeId": int(organize_id),
        "organizeHighNo": int(max_high_no),
        "categoryHighNo": 2,
        "repeatModel": "R",
    }
    data = post_json(token, path, body)
    if isinstance(data, list):
        return data
    return data.get("list", []) if data else []


def fetch_zj_category_unqualified_info(token: str, start_date: str, end_date: str,
                                       max_high_no: int, organize_id: Any) -> List[Dict[str, Any]]:
    """
    每日自检（planType=ZJ）问题项级别不合格明细。
    必须传 repeatModel='R' 与 organizeId，否则后端报参数错误。
    返回行含：title（检查项名称）、categoryName（开店检查/打烊检查）、
              bxjcs（巡检次数）、bxjcsBhg（不合格次数）、bxjcsBhgl（不合格率）等。
    """
    path = "/web/ri/zj/stat/categoryUnqualifiedInfo?version=1"
    body = {
        "startDate": start_date,
        "endDate": end_date,
        "organizeId": int(organize_id),
        "organizeHighNo": int(max_high_no),
        "categoryHighNo": 2,
        "repeatModel": "R",
        "pageNumber": 1,
        "pageSize": 500,
    }
    data = post_json(token, path, body)
    if isinstance(data, list):
        return data
    return data.get("list", []) if data else []


def fetch_category_unqualified_info(token: str, start_date: str, end_date: str,
                                    max_high_no: int,
                                    template_id: Any = None) -> List[Dict[str, Any]]:
    """
    常规巡检（CG）问题项级别不合格明细，用于与自检对齐。

    传 templateId 时只返回该巡检模板的检查项，行数 = 该模板的检查项数。
    实测：QSC巡检表（直营）= 59 项、QSC巡检表（加盟）最新版 = 57 项，
    且 Σbxjcs == 报告数 × 模板项数、ΣbxjcsBhg == Σ门店巡检汇总.sumCount，
    因此可以按「报告数 × 模板项数」精确还原每个门店的巡检项数。
    """
    path = "/web/ri/cg/stat/categoryUnqualifiedInfo?version=1"
    oid = _oid(None)  # 当前组织上下文
    body = {
        "startDate": start_date,
        "endDate": end_date,
        "organizeHighNo": int(max_high_no),
        "categoryHighNo": 2,
        "pageNumber": 1,
        "pageSize": 500,
    }
    if template_id not in (None, ""):
        body["templateId"] = template_id
    if oid is not None:
        body["organizeId"] = int(oid)
    data = post_json(token, path, body)
    if isinstance(data, list):
        return data
    return data.get("list", []) if data else []


def _item_payload(row: Dict[str, Any], start_date: str, end_date: str,
                  max_high_no: int = 4) -> Dict[str, Any]:
    """
    构造「问题项级」下钻请求体。

    慧运营前端的做法是：把 categoryUnqualifiedInfo 返回的整行对象作为 data 直接 POST，
    并额外补上起止时间。这里复刻同样的结构。
    """
    payload = dict(row or {})
    payload.pop("bhgmdName", None)
    payload["startDate"] = start_date
    payload["endDate"] = end_date
    payload["categoryHighNo"] = 2
    payload["organizeHighNo"] = int(max_high_no)
    return payload


def fetch_cg_item_store_list(token: str, row: Dict[str, Any], start_date: str,
                             end_date: str, max_high_no: int = 4) -> List[Dict[str, Any]]:
    """
    某个巡检项的不合格门店清单。
    返回 [{"organizeId":..., "organizeName":"广州岭南新世界店", "num":2}, ...]
    """
    path = "/statRi/web/ri/cg/stat/categoryUnqualifiedInfo/storeList?version=1"
    data = post_json(token, path, _item_payload(row, start_date, end_date, max_high_no))
    return data if isinstance(data, list) else []


def fetch_cg_item_pictures(token: str, row: Dict[str, Any], start_date: str,
                           end_date: str, max_high_no: int = 4) -> List[Dict[str, Any]]:
    """
    某个巡检项的不合格现场照片。
    返回 [{"uploadTime":"2026-08-06","urls":["cjss/ri/runtime/...","..."]}, ...]
    """
    path = "/statRi/web/ri/cg/stat/categoryUnqualifiedInfo/pictureList?version=1"
    data = post_json(token, path, _item_payload(row, start_date, end_date, max_high_no))
    return data if isinstance(data, list) else []


def fetch_cg_category_stores(token: str, row: Dict[str, Any], start_date: str,
                             end_date: str, max_high_no: int = 4) -> List[Dict[str, Any]]:
    """
    某个巡检分类的不合格门店清单（带每家门店的不合格次数）。
    返回 [{"storeId":..., "fullName":"桂林万象城店", "orgName":".../谢艺坤区域",
           "franchiseeName":"马艺文", "bxjmdsBhg":1}, ...]
    """
    path = "/web/ri/cg/stat/categoryUnqualifiedTotalStores?version=1"
    data = post_json(token, path, _item_payload(row, start_date, end_date, max_high_no))
    return data if isinstance(data, list) else []


# 总部 token 与组织树缓存（跨组复用，避免重复登录/重复拉大树）
_tree_cache: Dict[str, Any] = {"token": None, "tree": None}


def _tree_session(force: bool = False) -> tuple:
    """
    返回 (可见整棵组织树的 token, 组织树)。
    优先切到「总部」角色——该角色 token 可以读到全量组织树。
    带缓存；force=True 时强制重新登录（用于 token 过期重试）。
    """
    if not force and _tree_cache.get("token") and _tree_cache.get("tree"):
        return _tree_cache["token"], _tree_cache["tree"]
    d = login()
    tk = d["token"]
    try:
        ps = list_positions(tk)
        hq = [p for p in ps if (p.get("organizeName") or "") == "总部"]
        if hq:
            sw = login(role=int(hq[0]["roleId"]), organize_id=int(hq[0]["organizeId"]))
            tk = sw["token"]
    except Exception as e:  # 切总部失败就用默认 token 兜底
        print(f"[WARN] 切换总部角色失败，沿用默认 token：{e}")
    tree = org_tree(tk, _retried=True)  # fix26: 防过期重试递归——force 登录拿的新 token 只用一次
    _tree_cache["token"] = tk
    _tree_cache["tree"] = tree
    return tk, tree


def switch_position_and_login(position_name: str = "", organize_name: str = "") -> tuple:
    """
    按组织名定位目标组织，返回 (token, matched_dict)。

    【两种策略，依次尝试】

    策略一 · 角色切换（旧路径，优先）：
      在 list_positions 的「可切换角色」里匹配 (roleName, organizeName)，
      再以该角色重新登录——token 的数据范围天然被限定在该组织。
      账号本身有该组织角色时走这条，行为与历史完全一致（不注入 organizeId）。
      看板原有账号（有 培训组/新店运营组/加盟营运组 角色）走这条。

    策略二 · 组织树解析 organizeId（新路径，回退）：
      账号【没有】该组织角色时（慧运营里没有任何账号能角色切换进全部四组：
      看板账号切不进新店筹建组，用户账号 888 切不进新店运营组/加盟营运组），
      改用「总部」角色 token（可见整棵组织树）在组织树里按组织名找到节点，
      把 organizeId 写入模块全局 _active_org_id，
      后续各报告接口自动带上 organizeId 按组织过滤，绕开角色切换的权限限制。
      用户账号 888（只有 培训组/总部 角色，但总部角色可见全树）走这条。

    matched 含 organizeId / organizeName。
    """
    global _active_org_id

    # ── 策略一：角色切换（旧路径）────────────────────────────────
    # 账号本身拥有该组织角色时，这条路径最稳，且保持与历史完全一致的行为：
    # token 的数据范围天然被限定在该组织，无需再给接口注入 organizeId。
    # 看板原有账号（有 培训组/新店运营组/加盟营运组 角色）走这条。
    try:
        default = login()
        positions = list_positions(default["token"])
        matched = None
        for pos in positions:
            rname = pos.get("roleName", "")
            oname = pos.get("organizeName", "")
            if position_name in rname and organize_name in oname:
                matched = pos
                break
        if matched:
            re_login = login(role=int(matched["roleId"]), organize_id=int(matched["organizeId"]))
            _active_org_id = None  # token 已按组织限定，不再注入 organizeId
            return re_login["token"], matched
    except Exception as e:
        print(f"[WARN] 角色切换不可用（{organize_name}），改用组织树取数：{e}")

    # ── 策略二：组织树解析 organizeId（新路径）──────────────────
    # 账号没有该组织角色时，用「可见全树的 token」+ 各报告接口显式传 organizeId，
    # 按组织过滤取数，绕开角色切换的权限限制。
    # 用户账号 888（只有 培训组/总部 角色，但有总部角色可见全树）走这条。
    token, tree = _tree_session()

    def _find(nodes, contain=False):
        for n in nodes:
            nm = n.get("organizeName") or ""
            hit = (organize_name in nm) if contain else (nm == organize_name)
            if hit:
                return n
            r = _find(n.get("child") or [], contain)
            if r:
                return r
        return None

    node = _find(tree) or _find(tree, contain=True)
    if node is None:
        raise RuntimeError(f"未在组织树中找到组织：'{organize_name}'")
    oid = node.get("organizeId")
    _active_org_id = int(oid) if oid is not None else None
    matched = {
        "organizeId": oid,
        "organizeName": node.get("organizeName") or organize_name,
        "roleName": position_name or "",
        "roleId": None,
        "currentStoreCount": node.get("currentStoreCount"),
    }
    return token, matched


def fetch_zj_plan_list(token: str, end_date: str = "") -> List[Dict[str, Any]]:
    """
    每日自检任务（计划）列表。
    end_date 非空时只返回在该日期仍有效的任务（过滤掉历史遗留任务）。
    返回行含 planId / planName / repeatModel / startDate / endDate。
    """
    path = "/web/ri/zj/plan/list?version=1"
    body = {"pageNumber": 1, "pageSize": 50, "planType": "ZJ"}
    data = post_json(token, path, body)
    rows = data if isinstance(data, list) else (data or {}).get("list", [])
    if end_date:
        rows = [r for r in rows if str(r.get("endDate") or "") >= end_date]
    return rows


def fetch_store_complete_rate(token: str, plan_id: Any, repeat_model: str,
                              start_date: str, end_date: str,
                              organize_id: Any) -> List[Dict[str, Any]]:
    """
    门店自检完成情况（慧运营「报表中心 → 自检完成情况 → 门店完成率汇总」同款接口）。

    这是唯一能给出「应完成」真实值的接口，且返回区域下的全部门店
    （含未提交自检报告的门店），因此比按 门店数×天数×2 估算更准确。

    返回行含：fullName / storeCode / organizeName /
              reportNum(已完成) / ywcReportNum(应完成) / wwcReportNum(未完成) /
              hgReportNum(合格) / bhgReportNum(不合格) / dppjf(点评平均分)
    """
    path = "/web/ri/stat/store/complete/rate?version=1"
    body = {
        "planType": "ZJ",
        "repeatModel": repeat_model or "R",
        "planId": plan_id,
        "startDate": start_date,
        "endDate": end_date,
        "organizeId": organize_id,
        "storeType": None,
        "storeId": None,
    }
    data = post_json(token, path, body)
    if isinstance(data, list):
        return data
    return (data or {}).get("list", []) if data else []


def flatten_orgs(nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把组织树拍平为列表"""
    out = []
    for n in nodes:
        out.append(n)
        if n.get("child"):
            out.extend(flatten_orgs(n["child"]))
    return out


def fetch_stores_by_organize(token: str, organize_id: Any) -> List[Dict[str, Any]]:
    """
    取指定组织（区域）下的全部门店清单。
    返回行含 storeId / storeCode / fullName / storeStatus 等。
    """
    path = "/web/md/store/list?version=1"
    body = {"organizeId": int(organize_id), "search": ""}
    data = post_json(token, path, body)
    if isinstance(data, list):
        return data
    return data.get("list", []) if data else []


def leaf_regions(token: str, root_name: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    取当前 token 权限下的叶子区域。
    若 root_name 非空，只返回该根节点下的叶子区域。
    每个元素含 organizeName / currentStoreCount / nameLink 等。
    """
    tree = org_tree(token)
    if root_name:
        node = None
        def find(nodes, name):
            for n in nodes:
                if n.get("organizeName") == name:
                    return n
                r = find(n.get("child", []), name)
                if r:
                    return r
            return None
        node = find(tree, root_name)
        if not node:
            return []
        tree = [node]
    flat = flatten_orgs(tree)
    leaves = [n for n in flat if not n.get("child")]
    return leaves


if __name__ == "__main__":
    print("API helper loaded.")
