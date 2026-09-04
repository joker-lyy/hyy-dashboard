import base64, json, urllib.request, urllib.error, sys
U = sys.argv[1]; P = sys.argv[2]
API = "https://api.github.com"
REPO = "joker-lyy/hyy-dashboard"
def req(method, path, data=None):
    url = f"{API}{path}"
    headers = {"Authorization": f"Basic {base64.b64encode(f'{U}:{P}'.encode()).decode()}",
               "Accept": "application/vnd.github+json",
               "Content-Type": "application/json"}
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
files = {
    "app.js": r"C:/Users/Administrator/WorkBuddy/2026-08-28-17-39-46/hyy_dashboard/gh_pages/app.js",
    "index.html": r"C:/Users/Administrator/WorkBuddy/2026-08-28-17-39-46/hyy_dashboard/gh_pages/index.html",
}
for name, local in files.items():
    with open(local, "rb") as f:
        content = f.read()
    st, meta = req("GET", f"/repos/{REPO}/contents/{name}")
    if st != 200:
        print(f"GET {name} fail: {st} {meta}"); continue
    sha = meta["sha"]
    b64 = base64.b64encode(content).decode()
    st2, resp = req("PUT", f"/repos/{REPO}/contents/{name}", {
        "message": f"fix(frontend): {name} 显示北京时间",
        "content": b64, "sha": sha, "branch": "main"})
    ok = resp.get('commit',{}).get('sha','?')[:8] if st2==200 else resp
    print(f"PUT {name}: http={st2} commit={ok}")
