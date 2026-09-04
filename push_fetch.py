import base64, json, urllib.request, urllib.error, sys
U = sys.argv[1]; P = sys.argv[2]
API = "https://api.github.com"; REPO = "joker-lyy/hyy-dashboard"
def req(method, path, data=None):
    url = f"{API}{path}"
    h = {"Authorization": f"Basic {base64.b64encode(f'{U}:{P}'.encode()).decode()}",
         "Accept": "application/vnd.github+json", "Content-Type": "application/json"}
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
path = "scripts/fetch_data.py"
with open(path, "rb") as f: content = f.read()
st, meta = req("GET", f"/repos/{REPO}/contents/{path}")
print("GET", path, st)
sha = meta["sha"]
b64 = base64.b64encode(content).decode()
st2, resp = req("PUT", f"/repos/{REPO}/contents/{path}", {
    "message": "fix(backend): generatedAt 改用 utcnow() 明确 UTC，前端转北京时间",
    "content": b64, "sha": sha, "branch": "main"})
print("PUT", path, "http=", st2, resp.get('commit',{}).get('sha','?')[:8] if st2==200 else resp)
# 触发 Actions
st3, r3 = req("POST", f"/repos/{REPO}/actions/workflows/update-data.yml/dispatches", {"ref":"main"})
print("dispatch http=", st3)
