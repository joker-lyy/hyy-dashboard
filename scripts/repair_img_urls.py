# -*- coding: utf-8 -*-
"""
fix151（2026-09-11）一次性修复：全仓图片 URL 因旧签名剥离正则连 '?' 一起删掉，
变成 xxx.jpg&x-oss-process=...（缺问号），OSS 返回 404，全站巡检照片打不开。
本脚本把仓库内所有数据文件统一修复为 xxx.jpg?x-oss-process=...，并顺带剥掉
可能残留的 Expires/OSSAccessKeyId/Signature 签名参数。幂等，可重复运行。

覆盖：data/unqualified_v2.json、data/details/*.json、data/reportDetails.part*.json
不覆盖：hhy-deploy 源文件（签名由 sync_ghpages.py 读取时剥离，源保持 API 原样）。
用法：python scripts/repair_img_urls.py
"""
import glob
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data")

SIG_PATS = (
    re.compile(r'[?&]Expires=\d+'),
    re.compile(r'[?&]OSSAccessKeyId=[^&"\' ]+'),
    re.compile(r'[?&]Signature=[^&"\' ]+'),
)
ORPHAN = re.compile(r'(?<!\?)&x-oss-process=')


def clean_text(s):
    before_sig = sum(len(p.findall(s)) for p in SIG_PATS)
    before_orph = len(ORPHAN.findall(s))
    for p in SIG_PATS:
        s = p.sub('', s)
    s = ORPHAN.sub('?x-oss-process=', s)
    return s, before_sig + before_orph


def repair_file(fp):
    with open(fp, "r", encoding="utf-8") as f:
        s = f.read()
    s2, n = clean_text(s)
    if not n:
        return 0
    with open(fp, "w", encoding="utf-8") as f:
        f.write(s2)
    return n


def main():
    targets = [os.path.join(DATA, "unqualified_v2.json")]
    targets += sorted(glob.glob(os.path.join(DATA, "details", "*.json")))
    targets += sorted(glob.glob(os.path.join(DATA, "reportDetails.part*.json")))
    total = 0
    files_changed = 0
    for fp in targets:
        if not os.path.exists(fp):
            continue
        n = repair_file(fp)
        total += n
        if n:
            files_changed += 1
            sz = os.path.getsize(fp) / 1048576
            print("fixed %6d 处  %s (%.0fMB)" % (n, os.path.relpath(fp, BASE), sz))
    print("----")
    print("修复文件 %d 个，共修复 URL %d 处" % (files_changed, total))
    # 终检：全仓不应再有孤儿 &x-oss-process=
    left = 0
    for fp in targets:
        if os.path.exists(fp):
            with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                left += len(ORPHAN.findall(f.read()))
    print("残留坏 URL：", left)
    return 0 if left == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
