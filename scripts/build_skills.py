#!/usr/bin/env python3
"""
扫描 E:\ClaudeWorkspace\.claude\Skills 目录，构建技能索引 JSON
输出: docs/data/skills/index.json
"""

import json, os, re, sys

SKILLS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "..", ".claude", "Skills")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "skills")

def parse_frontmatter(text):
    """解析 SKILL.md 的 YAML frontmatter"""
    m = re.match(r'^---\s*\n(.*?)\n---', text, re.DOTALL)
    if not m:
        return {}, text
    yaml_text = m.group(1)
    body = text[m.end():].strip()
    meta = {}
    for line in yaml_text.split('\n'):
        line = line.strip()
        if ':' in line:
            key, _, val = line.partition(':')
            key = key.strip()
            val = val.strip()
            # Handle multi-line description (>-)
            if val in ('>-', '|-', '>', '|'):
                val = ''
            meta[key] = val
    return meta, body

def scan_skills():
    skills = []
    if not os.path.isdir(SKILLS_DIR):
        print(f"Skills dir not found: {SKILLS_DIR}")
        return skills

    for root, dirs, files in os.walk(SKILLS_DIR):
        for f in files:
            if f.lower() != "skill.md":
                continue
            path = os.path.join(root, f)
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    text = fh.read()
            except Exception as e:
                print(f"  !! {path}: {e}")
                continue

            meta, body = parse_frontmatter(text)
            skill_name = meta.get("name") or os.path.basename(os.path.dirname(path))
            # Extract category from path relative to SKILLS_DIR
            rel = os.path.relpath(root, SKILLS_DIR)
            parts = rel.split(os.sep)
            category = parts[0] if len(parts) > 0 else ""

            desc = meta.get("description", "").strip().replace("\n", " ").replace("  ", " ")
            # Truncate description
            if len(desc) > 200:
                desc = desc[:197] + "..."

            skills.append({
                "name": skill_name,
                "description": desc,
                "category": category,
                "path": rel,
                "userInvocable": meta.get("user-invocable", "no").strip().lower() == "yes",
                "systemPrompt": body[:500] if body else "",
            })

    return skills

def main():
    skills = scan_skills()
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output = {
        "count": len(skills),
        "skills": skills,
    }
    out_path = os.path.join(OUTPUT_DIR, "index.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"[OK] {len(skills)} skills written to {out_path}")
    return output

if __name__ == "__main__":
    main()
