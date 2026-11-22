"""Subject navigation and metadata shared by the catalog and session history."""

SECTIONS = {"algorithms": "Algorithms", "oop": "OOP", "graphs": "Graphs", "db": "DB", "nn": "NN"}


def section_for(task):
    explicit = str(task.get("section", "")).lower()
    if explicit in SECTIONS:
        return explicit
    block = str(task.get("block", "")).lower()
    topic = str(task.get("topic", "")).lower()
    if block.startswith("oop") or topic == "oop":
        return "oop"
    if topic in ("db", "nn"):
        return topic
    if block.startswith("comb"):
        return "graphs"
    # The original ungrouped bank predates the graph-course sets and belongs
    # to Algorithms, including its graph-algorithm exercises.
    return "algorithms"


def set_for(task):
    return task.get("block") or "general-" + section_for(task)


def set_label(block, section):
    for prefix in ("comb", "oop"):
        if block.startswith(prefix) and block[len(prefix) :].isdigit():
            return f"{SECTIONS[section]} · Set {block[len(prefix) :]}"
    return "General questions" if block.startswith("general-") else block


def metadata(tasks, title=None, source="library"):
    sets = {}
    for task in tasks:
        section = section_for(task)
        block = set_for(task)
        sets[(section, block)] = {
            "id": block,
            "section": section,
            "name": set_label(block, section),
        }
    return {
        "title": title or " / ".join(item["name"] for item in sets.values()) or "Session",
        "source": source,
        "sections": sorted({section_for(t) for t in tasks}),
        "sets": list(sets.values()),
        "questions": [{"id": t["id"], "title": t["title"], "type": t["type"]} for t in tasks],
        "provenance": "recorded",
    }
