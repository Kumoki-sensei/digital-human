"""人格与系统提示词。

## 设计立场：默认不带人格

这个项目交付给谁，就该由谁决定「她是谁」。**默认状态下不预设任何人格**：
名字留空、风格留空，只保留一套中性的行为规则（说话简短、不编造、不假装做过事）。

理由很实际：
    · 把一个创作者的个人口味（昵称、口癖、毒舌设定）硬编码进默认值，
      等于把这个决定替用户做了，而且他还得先找到哪里能改；
    · 人格是最不该「默认」的东西 —— 它一旦被预设，用户就会以为那是产品设计的一部分。

想定制的人只需要在网页「设置 → 人格」里填两栏：
    name  —— 她叫什么
    style —— 她怎么说话（直接拼进系统提示词，可以写得很细）

结构上提示词由三部分组成：中性行为规则 + 当下情境（时间/看过的画面）+ 用户填的人格。
**行为规则不建议删** —— 那不是人格，那是「别胡说八道」的底线。
"""

from __future__ import annotations

import datetime as dt

from .session import Session

CORE_RULES = """\
你是一个实时数字人，通过语音和用户对话。遵守以下硬规则：

1. 说话要短。这是一次对话，不是在写文章：默认一到三句话说完。
   除非用户明确要求详细展开。
2. 不要用 markdown 语法（不要星号、井号、列表符号），你的回答会被朗读出来，
   这些符号念出来很蠢。要列举时用口语的「第一、第二」。
3. 不知道就说不知道。绝对不要假装自己查过、看过、做过某事。
4. 只有当工具真的返回了结果，才可以说「我查到了」。没调工具就不要编数据。
5. 涉及真实写操作（改设置、发消息、删东西）时，先说明你要做什么，等确认。
6. 如果用户给了你名字和性格设定，保持一致；但人格不能凌驾于诚实之上。
"""

#: 用户没填风格时的通用说话方式。注意这是「怎么说话」而不是「什么人」——
#: 不涉及昵称、口癖、亲疏关系，任何产品拿过去都不会显得别扭。
DEFAULT_STYLE = (
    "说话干净、有判断力，不谄媚也不敷衍。"
    "对方说得含糊时你会追问一句；对方明确要答案时你直接给答案。"
)


def build_system_prompt(
    session: Session,
    *,
    name: str = "",
    style: str = "",
    extra: str = "",
) -> str:
    now = dt.datetime.now()
    clean_name = (name or "").strip()
    clean_style = (style or "").strip()

    parts = [
        CORE_RULES,
        f"现在的时间是 {now.strftime('%Y年%m月%d日 %H:%M')}（{_weekday(now)}）。",
    ]

    if clean_name:
        parts.append(f"你的名字是「{clean_name}」。")
    else:
        # 明确说「还没有名字」，否则模型会自己编一个 —— 用户问「你是谁」时
        # 它一本正经地报个假名字，比说「我还没名字」尴尬得多。
        parts.append(
            "用户还没有给你设定名字。如果被问到名字，如实说还没有设定、"
            "可以去设置里填一个，不要自己编一个名字。"
        )

    if clean_style:
        parts.append("你的性格与说话方式：\n" + clean_style)
    else:
        parts.append("你的性格与说话方式：" + DEFAULT_STYLE)

    if session.vision_notes:
        parts.append(
            "你最近看到过的画面记录（不必主动提起，只在相关时引用）：\n"
            + "\n".join(session.vision_notes[-4:])
        )
    if extra.strip():
        parts.append(extra.strip())
    return "\n\n".join(parts)


def _weekday(d: dt.datetime) -> str:
    return "星期" + "一二三四五六日"[d.weekday()]
