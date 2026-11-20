"""Extract the supplied PDF and build the standalone userscript; no downloads."""
import collections
import json
from pathlib import Path
import re
import sys

import fitz

def extract(source):
    bank, pending = [], []
    document = fitz.open(source)
    answer_markers = 0
    for page, pdf_page in enumerate(document, 1):
        for raw in pdf_page.get_text().splitlines():
            line = raw.strip()
            if not line:
                continue
            if page == 1 and not bank and not pending and line in {
                "单选题和判断题", "多选题", "1", "152"
            }:
                continue
            if page == 152 and line == "多选题":
                continue
            match = re.fullmatch(r"答案[：:]\s*([A-J]+)", line)
            if not match:
                pending.append((line, page))
                continue
            answer_markers += 1
            body = "\n".join(text for text, _ in pending)
            options = list(re.finditer(r"(?m)^([A-J])[.．、]\s*", body))
            letters = [option[1] for option in options]
            if not options or letters != list("ABCDEFGHIJ"[:len(options)]):
                raise ValueError(f"第 {page} 页选项异常：{body!r}")
            title = body[:options[0].start()].replace("\n", "").strip()
            texts = [body[option.end():options[i+1].start() if i+1 < len(options)
                          else len(body)].replace("\n", "").strip()
                     for i, option in enumerate(options)]
            if not title or any(not text for text in texts) or not set(match[1]) <= set(letters):
                raise ValueError(f"第 {page} 页题目或答案异常：{body!r}")
            bank.append({"title": title, "options": texts, "answer": match[1],
                         "page": pending[0][1], "endPage": page})
            pending = []
    if pending:
        raise ValueError(f"存在未解析尾部：{pending!r}")
    return bank, answer_markers


if __name__ == "__main__":
    root = Path(__file__).resolve().parent
    bank, count = extract(Path(sys.argv[1]))
    script = (root / "report-helper.user.js").read_text(encoding="utf-8")
    script = re.sub(r"(?m)^    const BANK = .*?;$", lambda _: "    const BANK = " + json.dumps(bank, ensure_ascii=False) + ";", script, count=1)
    (root / "personal.user.js").write_text(script, encoding="utf-8")
    print(count)
