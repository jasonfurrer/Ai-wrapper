"""
Claude LLM agents for activity note processing.
Uses ANTHROPIC_API_KEY; all agents return structured data for the activity page.
"""

import json
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Optional

from anthropic import Anthropic
import requests

from app.core.config import get_settings

logger = logging.getLogger(__name__)

# Domains we treat as consumer/personal email (not company); contact domain won't be used for company confirmation.
CONSUMER_EMAIL_DOMAINS = frozenset({
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "outlook.com", "hotmail.com",
    "hotmail.co.uk", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com",
    "protonmail.com", "proton.me", "zoho.com", "mail.com", "yandex.com", "gmx.com", "gmx.net",
})

# Default model for all agents
DEFAULT_MODEL = "claude-sonnet-4-20250514"
DEFAULT_MAX_TOKENS = 2048


def _get_client() -> Anthropic:
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise ValueError("ANTHROPIC_API_KEY is not set")
    return Anthropic(api_key=settings.anthropic_api_key)


def _get_first_text_from_message(msg) -> str | None:
    """Safely get the first text block from an Anthropic message. Returns None if empty or no text block."""
    content = getattr(msg, "content", None)
    if not content:
        return None
    for block in content:
        text = getattr(block, "text", None)
        if text is not None and isinstance(text, str) and text.strip():
            return text
    return None


def _parse_json_block(text: str) -> dict | list | None:
    """Extract JSON from a markdown code block or raw JSON in the response."""
    text = text.strip()
    # Try to find ```json ... ``` or ``` ... ```
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if match:
        text = match.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to find first { or [ and parse from there
        for start in ("{", "["):
            idx = text.find(start)
            if idx != -1:
                try:
                    return json.loads(text[idx:])
                except json.JSONDecodeError:
                    continue
    return None


# ---------------------------------------------------------------------------
# 1. Summary of communication history (legacy: returns plain text)
# ---------------------------------------------------------------------------

def summarize_communication_history(full_notes: str) -> str:
    """
    Produce a short summary of the full notes history for this contact.
    Used for the "Summary of Communication History" section (view only).
    """
    result = generate_communication_summary(full_notes)
    return result.get("summary") or "No communication history yet."


# ---------------------------------------------------------------------------
# 1b. Communication summary agent (summary + times contacted + relationship status)
# ---------------------------------------------------------------------------

def generate_communication_summary(full_notes: str) -> dict:
    """
    Analyse client notes and return structured communication summary:
    - summary: concise summary of the notes
    - times_contacted: what can be recognised from the notes (e.g. "3 calls, 2 emails in Jan 2025")
    - relationship_status: relationship status inferred from the notes (e.g. "Warm", "Prospect", "Customer")
    Used for the Communication Summary section on the activity page; stored per task in Supabase.
    """
    logger.info("[generate_communication_summary] entry full_notes_len=%s", len(full_notes or ""))
    if not full_notes or not full_notes.strip():
        logger.info("[generate_communication_summary] empty notes, returning default")
        return {
            "summary": "No communication history yet.",
            "times_contacted": "",
            "relationship_status": "",
        }
    prompt = """You are an assistant that analyses client communication notes for a sales/relationship manager.

Given the full notes history below (often with date-prefixed entries), produce a structured analysis.

Respond with ONLY a JSON object in this exact format, no other text:
{
  "summary": "2-4 short paragraphs: key topics, outcomes, commitments, next steps, and relationship context.",
  "times_contacted": "What you can recognise from the notes about how often or when they were contacted (e.g. '3 calls in January, 2 emails in February', or 'Initial call 01/15, follow-up 01/22'). If unclear, say 'Not clearly stated' or similar.",
  "relationship_status": "One short phrase for the relationship status as it appears from the notes (e.g. 'Prospect', 'Warm lead', 'Existing customer', 'Churned'). If unclear, use 'Unknown'."
}

Notes:
"""
    # Truncate notes to avoid token/size limits and API errors
    max_notes_len = 50_000
    notes_to_send = (full_notes[:max_notes_len] + "...") if len(full_notes) > max_notes_len else full_notes
    content_len = len(prompt) + len(notes_to_send)
    logger.info("[generate_communication_summary] notes_to_send_len=%s total_content_len=%s", len(notes_to_send), content_len)
    try:
        client = _get_client()
        logger.info("[generate_communication_summary] calling Claude API model=%s", DEFAULT_MODEL)
        msg = client.messages.create(
            model=DEFAULT_MODEL,
            max_tokens=DEFAULT_MAX_TOKENS,
            messages=[{"role": "user", "content": prompt + notes_to_send}],
        )
        content_blocks = getattr(msg, "content", None) or []
        logger.info("[generate_communication_summary] response received content_blocks=%s", len(content_blocks))
        text = _get_first_text_from_message(msg)
        if text:
            logger.info("[generate_communication_summary] first text block len=%s preview=%s", len(text), (text[:200] + "..." if len(text) > 200 else text))
            parsed = _parse_json_block(text)
            if isinstance(parsed, dict):
                logger.info("[generate_communication_summary] parsed JSON ok keys=%s", list(parsed.keys()) if parsed else None)
                return {
                    "summary": (parsed.get("summary") or "").strip() or "No summary generated.",
                    "times_contacted": (parsed.get("times_contacted") or "").strip(),
                    "relationship_status": (parsed.get("relationship_status") or "").strip(),
                }
            logger.warning("[generate_communication_summary] parsed result not a dict: type=%s", type(parsed).__name__)
        else:
            logger.warning("[generate_communication_summary] no text in response (blocks=%s)", len(content_blocks))
    except ValueError as e:
        logger.warning("[generate_communication_summary] config error: %s", e)
        return {
            "summary": "Unable to generate summary. Please try again.",
            "times_contacted": "",
            "relationship_status": "",
        }
    except Exception as e:
        logger.exception(
            "[generate_communication_summary] exception type=%s msg=%s",
            type(e).__name__,
            str(e),
        )
        return {
            "summary": "Unable to generate summary. Please try again.",
            "times_contacted": "",
            "relationship_status": "",
        }
    logger.info("[generate_communication_summary] falling through to no-summary (no text or parse failed)")
    return {
        "summary": "No summary generated.",
        "times_contacted": "",
        "relationship_status": "",
    }


# ---------------------------------------------------------------------------
# 2. Recognised date (from note text, e.g. "next week")
# ---------------------------------------------------------------------------

def extract_recognised_date(latest_note: str, reference_date: datetime | None = None) -> dict:
    """
    Extract the due date for the upcoming task if the note mentions a specific or relative date
    (e.g. "by Friday", "next week", "follow up on the 15th"). Returns YYYY-MM-DD and a label.
    reference_date: use for relative phrases; default now.
    """
    if not latest_note or not latest_note.strip():
        return {"date": None, "label": None, "confidence": 0}
    ref = reference_date or datetime.now(timezone.utc)
    client = _get_client()
    prompt = f"""You are a precise assistant that extracts the DUE DATE for an upcoming task from activity or meeting notes.

**Reference (today):** {ref.strftime("%Y-%m-%d")} ({ref.strftime("%A, %B %d, %Y")}).

**Your task:** From the note below, identify exactly one date that represents when something is due, scheduled, or should happen next. Look for:
- Explicit dates: "by March 15", "due 2025-03-20", "on Friday"
- Relative dates: "next week", "in two weeks", "end of month", "next Wednesday"
- Commitments: "follow up next Tuesday", "send proposal by end of week"

**Rules:**
- Return the date as YYYY-MM-DD. For "next Friday" use the upcoming Friday from the reference date.
- "End of week" = Friday of the current or next week as appropriate; "end of month" = last day of the month.
- label: A short human-readable label (e.g. "Next Wednesday", "By end of week").
- confidence: 0-100. Use 85+ when the date is explicit; 60-84 when inferred from relative phrases; 0-59 when ambiguous.
- If no clear due/scheduled date is mentioned or implied, set "date" to null, "label" to null, "confidence" to 0.

Respond with ONLY a JSON object, no other text or markdown:
{{"date": "YYYY-MM-DD" or null, "label": "short label" or null, "confidence": number}}
"""
    try:
        msg = client.messages.create(
            model=DEFAULT_MODEL,
            max_tokens=512,
            messages=[{"role": "user", "content": prompt + "\n\nNote:\n" + latest_note}],
        )
        block = msg.content[0] if msg.content else None
        if block and getattr(block, "text", None):
            parsed = _parse_json_block(block.text)
            if isinstance(parsed, dict):
                date_val = parsed.get("date")
                if date_val and isinstance(date_val, str) and re.match(r"\d{4}-\d{2}-\d{2}", date_val):
                    return {
                        "date": date_val,
                        "label": parsed.get("label") or date_val,
                        "confidence": min(100, max(0, int(parsed.get("confidence", 70)))),
                    }
                return {
                    "date": None,
                    "label": parsed.get("label"),
                    "confidence": min(100, max(0, int(parsed.get("confidence", 0)))),
                }
    except Exception as e:
        logger.exception("Claude extract_recognised_date error: %s", e)
    return {"date": None, "label": None, "confidence": 0}


# ---------------------------------------------------------------------------
# 3. Recommended touch date (next due date suggestion)
# ---------------------------------------------------------------------------

def recommend_touch_date(
    latest_note: str,
    previous_notes: str = "",
    reference_date: datetime | None = None,
) -> dict:
    """
    Based on relationship health and prior meeting patterns, suggest the next due date.
    Returns date (YYYY-MM-DD), label, and rationale.
    """
    ref = reference_date or datetime.now(timezone.utc)
    client = _get_client()
    context = "Previous notes for this contact:\n" + (previous_notes or "None.") if previous_notes else "No previous notes."
    prompt = f"""You are an assistant that suggests the next follow-up (touch) date for a client relationship.

Reference date: {ref.strftime("%Y-%m-%d")} ({ref.strftime("%A")}).

{context}

Latest note:
{latest_note or "No latest note."}

Based on the content (commitments, "let's meet next week", typical follow-up cycles), suggest ONE recommended next touch date as YYYY-MM-DD. Provide a short label (e.g. "1 week from now") and a one-sentence rationale.

Respond with ONLY a JSON object:
{{"date": "YYYY-MM-DD", "label": "short label", "rationale": "one sentence"}}
"""
    try:
        msg = client.messages.create(
            model=DEFAULT_MODEL,
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        block = msg.content[0] if msg.content else None
        if block and getattr(block, "text", None):
            parsed = _parse_json_block(block.text)
            if isinstance(parsed, dict) and parsed.get("date"):
                return {
                    "date": str(parsed["date"])[:10],
                    "label": parsed.get("label") or parsed["date"],
                    "rationale": parsed.get("rationale") or "Based on note context.",
                }
    except Exception as e:
        logger.exception("Claude recommend_touch_date error: %s", e)
    # Fallback: 1 week from now
    one_week = (ref + timedelta(days=7)).strftime("%Y-%m-%d")
    return {"date": one_week, "label": "1 week from now", "rationale": "Default follow-up in one week."}


# ---------------------------------------------------------------------------
# 4. Extracted metadata (subject, next steps, questions, urgency)
# ---------------------------------------------------------------------------

def extract_metadata(latest_note: str, previous_notes: str = "") -> dict:
    """
    Extract subject (task title), questions raised, and urgency from the latest note.
    Uses previous notes only for context when present.
    """
    if not latest_note or not latest_note.strip():
        return {
            "subject": "",
            "questions_raised": "",
            "urgency": "medium",
            "subject_confidence": 0,
            "questions_confidence": 0,
        }
    client = _get_client()
    context = ""
    if previous_notes and previous_notes.strip():
        context = "**Previous notes (context only):**\n" + (previous_notes[:3000] + "..." if len(previous_notes) > 3000 else previous_notes) + "\n\n"
    prompt = f"""You are a CRM metadata extraction agent. From the latest activity/meeting note, extract structured fields for the upcoming task. Be consistent and accurate.

{context}**Latest note:**
{latest_note[:8000]}

**Extract and respond with ONLY a JSON object (no markdown, no explanation):**

1. **subject** (string): A single, short task title for the upcoming task (e.g. "Follow-up call with Jane", "Send Q4 proposal", "Review contract"). One phrase, title case. This is the task title in the CRM.

2. **questions_raised** (string): Any open questions the contact raised or that remain unanswered. Empty string if none.

3. **urgency** (string): Exactly one of "low", "medium", "high". Use "high" for time-sensitive or commitment-heavy notes; "medium" for normal follow-ups; "low" for informational or casual notes.

4. **subject_confidence**, **questions_confidence** (integers 0-100): How confident you are in each extraction. 85+ when explicit in the note; 50-84 when inferred; below 50 when vague.

**Output format (JSON only):**
{{"subject": "...", "questions_raised": "...", "urgency": "low"|"medium"|"high", "subject_confidence": number, "questions_confidence": number}}
"""
    try:
        msg = client.messages.create(
            model=DEFAULT_MODEL,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        block = msg.content[0] if msg.content else None
        if block and getattr(block, "text", None):
            parsed = _parse_json_block(block.text)
            if isinstance(parsed, dict):
                urgency = (parsed.get("urgency") or "medium").lower()
                if urgency not in ("low", "medium", "high"):
                    urgency = "medium"
                return {
                    "subject": (parsed.get("subject") or "").strip() or "Follow-up",
                    "questions_raised": (parsed.get("questions_raised") or "").strip(),
                    "urgency": urgency,
                    "subject_confidence": min(100, max(0, int(parsed.get("subject_confidence", 70)))),
                    "questions_confidence": min(100, max(0, int(parsed.get("questions_confidence", 70)))),
                }
    except Exception as e:
        logger.exception("Claude extract_metadata error: %s", e)
    return {
        "subject": "Follow-up",
        "questions_raised": "",
        "urgency": "medium",
        "subject_confidence": 50,
        "questions_confidence": 50,
    }


# ---------------------------------------------------------------------------
# 5. AI-generated drafts (original = user text; formal, concise, detailed)
# ---------------------------------------------------------------------------

def generate_drafts(
    current_note: str,
    previous_notes: str = "",
    tones: list[str] | None = None,
) -> dict[str, dict]:
    """
    Generate three AI drafts from the current note: formal, concise, and detailed.
    original is always the user's current note unchanged. Detailed uses previous_notes + current
    to produce a note that describes the latest interaction with relevant prior context.
    Returns dict keyed by tone: { "original": {text, confidence}, "formal": {...}, ... }.
    """
    if tones is None:
        tones = ["original", "formal", "concise", "detailed"]
    original_text = (current_note or "").strip() or "No notes provided."
    client = _get_client()
    prev_context = ""
    if previous_notes and previous_notes.strip():
        prev_context = (
            "**Previous client/activity notes (use only for context in the 'detailed' draft):**\n"
            + (previous_notes[:4000] + "..." if len(previous_notes) > 4000 else previous_notes)
            + "\n\n"
        )
    prompt = f"""You are a professional assistant that rewrites meeting/activity notes for a CRM. The user has provided their current draft note. Produce three alternative versions: formal, concise, and detailed.

{prev_context}**Current note (user's draft) to rewrite:**
{original_text[:6000]}

**Requirements for each draft:**

1. **formal**: Rewrite the note in a formal, professional tone. Use complete sentences, avoid colloquialisms, and maintain a business-appropriate register. Keep the same factual content. Confidence 0-100 based on how well the note fits a formal style.

2. **concise**: Make the note more concise. Preserve all key facts, outcomes, and commitments but use fewer words. Prefer short sentences and bullet-like clarity. Remove filler. Confidence 0-100.

3. **detailed**: Produce a note that describes the latest interaction in detail. Wherever relevant and necessary, weave in brief context from the previous notes above (e.g. "Following up on the Q1 goals discussed previously..." or "As agreed in the last call..."). The note should still focus on the latest meeting/email but give enough prior context for someone reading only this note to understand the fuller picture. Use flowing prose, 2-4 paragraphs if appropriate. Confidence 0-100.

**Output:** Return ONLY a JSON object with keys: formal, concise, detailed. Each value is an object with "text" (string) and "confidence" (integer 0-100). Do not include "original" in the JSON — the system will use the user's draft as original.
{{"formal": {{"text": "...", "confidence": number}}, "concise": {{"text": "...", "confidence": number}}, "detailed": {{"text": "...", "confidence": number}}}}
"""
    try:
        msg = client.messages.create(
            model=DEFAULT_MODEL,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        block = msg.content[0] if msg.content else None
        if block and getattr(block, "text", None):
            parsed = _parse_json_block(block.text)
            if isinstance(parsed, dict):
                result: dict[str, dict] = {"original": {"text": original_text, "confidence": 100}}
                for t in ["formal", "concise", "detailed"]:
                    if t not in result and t in tones:
                        val = parsed.get(t)
                        if isinstance(val, dict) and "text" in val:
                            result[t] = {
                                "text": str(val["text"]).strip() or original_text,
                                "confidence": min(100, max(0, int(val.get("confidence", 75)))),
                            }
                        else:
                            result[t] = {"text": original_text, "confidence": 70}
                return result
    except Exception as e:
        logger.exception("Claude generate_drafts error: %s", e)
    return {
        "original": {"text": original_text, "confidence": 100},
        "formal": {"text": original_text, "confidence": 70},
        "concise": {"text": original_text, "confidence": 70},
        "detailed": {"text": original_text, "confidence": 70},
    }


def regenerate_single_draft(
    current_note: str,
    previous_notes: str,
    tone: str,
) -> dict:
    """Regenerate only one draft tone (e.g. after user clicks Regenerate for "formal")."""
    drafts = generate_drafts(current_note, previous_notes, tones=[tone])
    return drafts.get(tone, {"text": (current_note or "").strip(), "confidence": 70})


# ---------------------------------------------------------------------------
# 5b. Smart compose: email drafts from instructions + client notes + task context
# ---------------------------------------------------------------------------

def generate_email_drafts(
    email_instructions: str,
    client_notes: str,
    task_title: str,
    last_touch_date: str | None = None,
    sender_name: str | None = None,
) -> tuple[dict[str, dict], str]:
    """
    Generate three email drafts (warm, concise, formal) for the Smart compose feature.
    Uses email instructions + task title to define the email objective; client notes and
    last touch date as context. sender_name is used in the sign-off (no placeholder).
    Returns (drafts_dict, suggested_subject). suggested_subject is derived per prompt rules.
    """
    instructions = (email_instructions or "").strip()
    notes = (client_notes or "").strip()
    title = (task_title or "").strip()
    last_touch = (last_touch_date or "").strip()
    sender = (sender_name or "").strip()

    logger.info(
        "[generate_email_drafts] sender_name_raw=%r sender=%r title=%r has_notes=%s has_instructions=%s last_touch=%r",
        sender_name,
        sender,
        title,
        bool(notes),
        bool(instructions),
        last_touch,
    )

    if not notes and not title and not instructions:
        fallback = "No context provided. Add client notes, a task title, or email instructions and try again."
        return (
            {
                "warm": {"text": fallback, "confidence": 0},
                "concise": {"text": fallback, "confidence": 0},
                "formal": {"text": fallback, "confidence": 0},
            },
            "",
        )

    client = _get_client()
    max_notes_len = 24_000
    notes_to_send = (notes[:max_notes_len] + "\n\n[Notes truncated for length.]") if len(notes) > max_notes_len else notes

    last_touch_block = ""
    if last_touch:
        last_touch_block = (
            "\n**Last touch date (last contact with this person/account):** "
            f"{last_touch}\nUse this to inform tone (e.g. 'following up after our conversation on...') where relevant."
        )

    sender_block = ""
    if sender:
        sender_block = (
            f"\n**Sender name (use this exact name in the sign-off of every draft):** {sender}\n"
            "Do NOT use '[Your name]', '[Sender]', or any placeholder. End each draft with the actual sign-off using this name (e.g. 'Best regards,\n{sender}' or 'Thanks,\n{sender}')."
        )
    else:
        sender_block = (
            "\n**Sender name:** Not provided. Use a professional sign-off followed by a generic placeholder such as '[Your name]' or '[Sender]' only in this case."
        )

    prompt = f"""You are an expert sales and relationship email writer. Your task is to generate three ready-to-send email drafts for the same situation, each in a different tone: **warm**, **concise**, and **formal**. You must also output a single **suggested_subject** line for the email.

**Primary objective (you must respect this):**
- The **task title** and **email draft instructions** together define the main objective of the email.
- The task title is the *purpose* of the outreach in the CRM (e.g. "Check in with Acme Corp", "Follow-up on contract", "Send proposal"). The instructions add specifics: tone preferences, points to include, things to avoid, structure, or **a subject line**.
- Example: if the task title is "Check in with Acme Corp" and instructions say "mention the Q2 proposal and ask for a 15-min call", the email must be a check-in that references the Q2 proposal and invites a 15-minute call. Do not write a generic follow-up if the objective is a check-in.
- Both task title and instructions are mandatory context for what the email must achieve.

**Subject line (suggested_subject) — follow this order of precedence:**
1. **If the email draft instructions explicitly mention or specify a subject line** (e.g. "subject: Follow-up on our call", "use subject: Q2 proposal attached", "email subject should be..."), use that as the suggested_subject. Extract or paraphrase exactly what the user asked for; do not substitute the task title unless it matches.
2. **If the instructions do not specify a subject**, derive a subject from the **context of the current email**: the purpose of the email, the relationship (from client notes), and the main ask or topic. The subject should be concise (under ~60 characters when practical), clear, and specific to this email (e.g. "Quick follow-up on Q2 proposal", "Availability for a 15-min call next week", "Thank you – next steps").
3. **Use the task title as the email subject only when** (a) it naturally reads as an email subject line (e.g. "Follow-up on contract", "Send proposal"), and (b) the instructions did not specify a subject and the task title accurately reflects the email content. Do NOT default to the task title when a more specific, context-derived subject is possible (e.g. task title "Check in with Acme Corp" → prefer a subject like "Checking in – Q2 proposal and next steps" over literally "Check in with Acme Corp" unless the user instructed otherwise).
Output the chosen subject in the **suggested_subject** field of your JSON.

**Context you must use:**
1. **Client notes** (below): Same notes used for the contact's communication history. Use them to:
   - Pull relevant facts, commitments, and prior discussion points so the email is accurate and personalised.
   - Reference specific details (e.g. "as we discussed on the call", "the timeline you mentioned") where they support the objective.
   - Avoid inventing facts; only use information that appears in the notes.
2. **Last touch date** (if provided): Use it to frame recency (e.g. "following up from our conversation on...", "it's been a few weeks since we last spoke").
{sender_block}
{last_touch_block}

**Requirements for each draft:**
- **Warm**: Friendly, personable, and relationship-oriented. Use a natural, conversational tone while remaining professional. Include an appropriate greeting and sign-off. Use the sender name in the sign-off when provided (no placeholders).
- **Concise**: Short and to the point. Lead with the objective; minimal preamble. Clear sentences; bullets only if they add clarity. No filler. Get the ask or next step in early. Use the sender name in the sign-off when provided.
- **Formal**: Professional, polished, suitable for senior or external stakeholders. Complete sentences, proper salutation and sign-off (e.g. "Dear [Contact Name]", "Best regards"). Avoid colloquialisms. Use the sender name in the sign-off when provided.

**Rules (strict):**
- Each draft must be a **complete email body** only (no subject line inside the body). Include a greeting and a sign-off in each draft.
- **Sign-off:** When the sender name is provided, every draft must end with the actual sender name (e.g. "Best regards,\nJohn Smith"). Never use "[Your name]", "[Sender]", or similar when the sender name is given. When not provided, you may use a placeholder.
- All three drafts must fulfil the **same objective** (task title + instructions); only the tone and length differ.
- Do not make up names, dates, or facts not present in the client notes. If the recipient's name is unknown, use "[Contact Name]" or "there" in the greeting only.
- Output **only** valid JSON. No markdown code fences, no explanation. Use this exact structure (include suggested_subject at the top level):
{{"suggested_subject": "<one subject line string>", "warm": {{"text": "<full email body>", "confidence": number}}, "concise": {{"text": "<full email body>", "confidence": number}}, "formal": {{"text": "<full email body>", "confidence": number}}}}
- confidence: integer 0–100 per draft. 85+ when context clearly supports the draft; 70–84 when partial; 50–69 when thin but objective is clear; below 50 when inferring heavily.

---
**Task title (CRM purpose of the outreach; use for objective and only for subject when it fits per rules above):**
{title or "(none provided)"}

**Email draft instructions (user-specific guidance; check here first for an explicit subject):**
{instructions or "(none provided)"}
---
**Client notes (use for accuracy and personalisation):**
{notes_to_send or "(none provided)"}
"""

    try:
        msg = client.messages.create(
            model=DEFAULT_MODEL,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        text = _get_first_text_from_message(msg)
        if not text:
            raise ValueError("No text in Claude response")
        parsed = _parse_json_block(text)
        if not isinstance(parsed, dict):
            raise ValueError("Response is not a JSON object")
        suggested_subject = (parsed.get("suggested_subject") or "").strip() if isinstance(parsed.get("suggested_subject"), str) else ""
        result: dict[str, dict] = {}
        for tone in ("warm", "concise", "formal"):
            val = parsed.get(tone)
            if isinstance(val, dict) and "text" in val:
                result[tone] = {
                    "text": str(val["text"]).strip() or "(No draft generated.)",
                    "confidence": min(100, max(0, int(val.get("confidence", 75)))),
                }
            else:
                result[tone] = {
                    "text": "(No draft generated for this tone.)",
                    "confidence": 0,
                }
        logger.info("[generate_email_drafts] success tones=%s suggested_subject=%s", list(result.keys()), suggested_subject[:50] if suggested_subject else "")
        return (result, suggested_subject)
    except Exception as e:
        logger.exception("[generate_email_drafts] error: %s", e)
        fallback = "Unable to generate drafts. Please try again."
        return (
            {
                "warm": {"text": fallback, "confidence": 0},
                "concise": {"text": fallback, "confidence": 0},
                "formal": {"text": fallback, "confidence": 0},
            },
            "",
        )


# ---------------------------------------------------------------------------
# 6. Extract contact + company from email (for "Import from communication")
# ---------------------------------------------------------------------------

def _domain_from_email(email: str) -> str:
    """Extract domain from an email address (e.g. contact@company.com -> company.com)."""
    if not email or "@" not in email:
        return ""
    return email.strip().rsplit("@", 1)[-1].lower()


def _is_consumer_email_domain(domain: str) -> bool:
    """True if the domain is a known consumer/personal email provider."""
    return (domain or "").lower() in CONSUMER_EMAIL_DOMAINS


def _company_name_from_domain(domain: str, timeout_sec: float = 4.0) -> Optional[str]:
    """
    Try to get a company name from the domain's homepage (e.g. fetch and parse <title>).
    Returns None on any failure or if title is not usable.
    """
    if not domain or "." not in domain:
        return None
    domain = domain.lower().strip()
    if domain.startswith("www."):
        domain = domain[4:]
    url = f"https://{domain}"
    try:
        resp = requests.get(url, timeout=timeout_sec, allow_redirects=True)
        resp.raise_for_status()
        text = (resp.text or "")[:100000]
        match = re.search(r"<title[^>]*>\s*([^<]+?)\s*</title>", text, re.IGNORECASE | re.DOTALL)
        if not match:
            return None
        title = match.group(1).strip()
        title = re.sub(r"\s+", " ", title)
        # Drop common suffixes that are not the company name
        for suffix in (" - home", " | home", " - official site", " - welcome", " | official site"):
            if title.lower().endswith(suffix):
                title = title[: -len(suffix)].strip()
        if len(title) < 2 or len(title) > 120:
            return None
        return title
    except Exception as e:
        logger.debug("Could not fetch title for domain %s: %s", domain, e)
        return None


def _normalize_company_for_compare(name: str) -> str:
    """Normalize company name for similarity (lowercase, remove common suffixes)."""
    if not name:
        return ""
    s = name.strip().lower()
    for suffix in (" inc", " inc.", " corp", " corp.", " ltd", " ltd.", " llc", " co.", " company"):
        if s.endswith(suffix):
            s = s[: -len(suffix)].strip()
    return re.sub(r"[^a-z0-9]", "", s)


def _confirm_company_from_contact_domain(result: dict) -> dict:
    """
    Use the contact's email domain to confirm or fill company_name and company_domain.
    If the contact email has a non-consumer domain (e.g. contact@company.com), use that domain
    as company_domain and optionally resolve company name from the domain (e.g. fetch homepage title).
    Reconcile with company name from the email body using internal confidence; frontend sees only
    the chosen company_name and company_domain.
    """
    contact_email = (result.get("email") or "").strip()
    if not contact_email or "@" not in contact_email:
        return result
    domain = _domain_from_email(contact_email)
    if not domain or _is_consumer_email_domain(domain):
        return result
    # Work-domain: use it for company_domain at least
    body_company = (result.get("company_name") or "").strip()
    body_domain = (result.get("company_domain") or "").strip().lower()
    # Ensure company_domain is set to contact's domain (we're confident it's work)
    result = {**result, "company_domain": result.get("company_domain") or domain}
    if body_domain and body_domain != domain:
        result["company_domain"] = domain  # Prefer contact domain for consistency
    # Try to get company name from domain (e.g. homepage title)
    domain_company = _company_name_from_domain(domain)
    if not domain_company:
        # Keep body company if any; domain is already set
        return result
    if not body_company:
        result["company_name"] = domain_company
        return result
    # Both present: reconcile by confidence (internal)
    norm_body = _normalize_company_for_compare(body_company)
    norm_domain = _normalize_company_for_compare(domain_company)
    if norm_body and norm_domain and (norm_body in norm_domain or norm_domain in norm_body or norm_body[:8] == norm_domain[:8]):
        # High confidence they refer to same company: keep body name (usually more formal)
        return result
    # Different: prefer body name if it looks formal (Inc/Corp etc.), else prefer domain title
    if re.search(r"\b(inc|corp|ltd|llc|co\.?)\b", body_company, re.I):
        return result
    result["company_name"] = domain_company
    return result


def _extract_email_address(header: str) -> str:
    """Extract a single email address from a header like 'Name <addr@domain.com>' or plain 'addr@domain.com'."""
    if not header or "@" not in header:
        return ""
    s = header.strip()
    if "<" in s and ">" in s:
        m = re.search(r"<([^>]+)>", s)
        return m.group(1).strip() if m else ""
    return s


def _contact_email_from_direction(sender: str, to: str, user_email: str) -> str:
    """
    Determine contact email from message direction when we know the current user's email.
    - Inbox email (user received): contact = sender → return From address.
    - Sent email (user sent): contact = receiver → return first To address (that is not the user).
    """
    u = user_email.strip().lower()
    from_addr = _extract_email_address(sender or "")
    if not from_addr:
        return ""
    # To can be multiple: "A <a@x.com>, B <b@y.com>" or "a@x.com, b@y.com"
    to_raw = (to or "").strip()
    if not to_raw:
        to_addresses = []
    else:
        to_addresses = []
        for part in re.split(r",\s*", to_raw):
            addr = _extract_email_address(part)
            if addr:
                to_addresses.append(addr)
    # User sent (From == user) → contact is recipient → use first To address
    if from_addr.lower() == u:
        for addr in to_addresses:
            if addr.lower() != u:
                return addr
        return to_addresses[0] if to_addresses else ""
    # User received (user is in To) → contact is sender → use From address
    if any(addr.lower() == u for addr in to_addresses) or (to_addresses and to_addresses[0].lower() == u):
        return from_addr
    # To might be a single string without comma; try parsing whole To as one
    single_to = _extract_email_address(to_raw)
    if single_to.lower() == u:
        return from_addr
    return ""


def extract_contact_from_email(
    sender: str,
    to: str,
    subject: str,
    body: str,
    user_email: str | None = None,
) -> dict:
    """
    Analyse email (sender, to, subject, body) and return structured contact and company fields
    for populating the contact form and optional company creation.
    user_email: the connected Gmail address of the current user; used to determine which party
    is "the contact" (the other party). If From == user_email, contact is the recipient (To).
    If To == user_email, contact is the sender (From).
    Returns dict with: first_name, last_name, email, phone, job_title, company_name,
    company_domain, city, state_region, company_owner. Empty string for missing fields.
    """
    empty = {
        "first_name": "",
        "last_name": "",
        "email": "",
        "phone": "",
        "job_title": "",
        "company_name": "",
        "company_domain": "",
        "city": "",
        "state_region": "",
        "company_owner": "",
    }
    combined = (sender or "") + (to or "") + (subject or "") + (body or "")
    if not combined.strip():
        return empty
    client = _get_client()

    user_email_instruction = ""
    if user_email and user_email.strip():
        user_email_instruction = (
            f"\n**Current user's email (the person using this tool):** {user_email.strip()}\n"
            "The CONTACT to extract is always the *other* party, not the user. Never extract the user's name, email, company, or phone as the contact.\n"
            "- **If the email was SENT by the user** (From matches the user's email): the contact is the RECIPIENT. Use the To field for contact email (extract the address only, e.g. from 'Name <a@b.com>' use 'a@b.com'). When there are multiple recipients in To, the contact is the **primary (first) recipient**—use the first address in To that is not the user. For name and other fields, use the To header display name and the part of the body that directly addresses the recipient (e.g. salutation). Do **not** use names, titles, or company from quoted replies or forwarded sections (e.g. \"On ... wrote:\", \"---------- Forwarded message ---------\").\n"
            "- **If the email was RECEIVED by the user** (To contains the user's email): the contact is the SENDER. Use the From field for contact email (extract the address only). For name and other fields, use the From header display name and the **sender's email signature** (see Email signatures below) as the primary source; then body/salutation if needed.\n"
        )
    else:
        user_email_instruction = (
            "\n**Note:** Current user's email was not provided. Treat the SENDER (From) as the contact and extract their details from the From header and the email body/signature. Do not assume the recipient is the contact unless context clearly indicates otherwise.\n"
        )

    prompt = """You are a CRM contact extraction agent. Your job is to extract structured contact and company information from a single email so it can be used to create or update a contact in HubSpot. Be thorough, consistent, and accurate.

**Rules**
1. Extract the MAIN contact (one person) and their organization. The contact is the person we want to add to the CRM.
2. Use only the From and To headers to determine the contact. Ignore CC and BCC.
3. For every field, extract the most specific value you can find. Use empty string "" only when you truly cannot determine a value.
4. Output ONLY valid JSON in the exact format below. Do not wrap the JSON in markdown code fences. No explanation, no other text. No trailing commas, no comments, no newlines inside string values; escape double quotes inside strings.
5. When there are multiple recipients (To), the contact is the **primary recipient**: the first address in To that is not the user. Use that party's display name and any signature or body content that refers to them (but for sent mail, do not use quoted/forwarded sections—see Email signatures).
6. If To contains only the user (e.g. self-sent or draft), leave contact fields empty unless one other party is clearly identifiable from the body.
7. **Do not** extract the current user's name, email, company, or phone as the contact. Do not infer company_name or company_domain from the contact's personal email domain (e.g. @gmail.com, @yahoo.com)—leave company fields empty unless the body or signature states a company.
""" + user_email_instruction + """
**Email signatures**
Professional email signatures often appear at the end of the message (after sign-offs like "Best regards", "Cheers", "Thanks", "Kind regards", or "---") and contain detailed contact information. When the contact is the **sender** (received mail), treat the sender's signature as the **primary source** for: name, job title, company name, phone, city/state, and company domain. Common signature patterns include: "Name | Job Title | Company", block format (name on one line, title below, company below, phone/address), and lines with "M:" or "T:" for mobile/phone. Ignore legal disclaimers, confidentiality notices, and social/media links for extraction. When the contact is the **recipient** (sent mail), use the To header and the part of the body that directly addresses the recipient (e.g. salutation); do **not** use names, titles, or company from quoted replies or forwarded sections (e.g. "On ... wrote:", "---------- Forwarded message ---------"). If no clear recipient info beyond To, rely on To display name only.

**Field definitions**
- **first_name, last_name:** The contact's given name and family name. For received mail the contact is the sender—use From display name and the sender's signature/body. For sent mail the contact is the recipient—use To display name and body that refers to them (not quoted/forwarded). Never use the user's name. If only one name is given (e.g. "John" or "John Smith"), put it in first_name and leave last_name "". If the format is "Last, First", use First as first_name and Last as last_name.
- **email:** The contact's email address only (e.g. "john@company.com"). If the user sent the email, contact email = first non-user address in To; if the user received it, contact email = From. Extract just the address from formats like "Name <email@domain.com>".
- **phone:** Phone number clearly associated with the contact. Prefer E.164 when a country code is present (e.g. +1 555 123 4567); otherwise digits only. Signatures often include "M:", "T:", "Tel:", or "Mobile:". If multiple numbers appear for the contact, prefer one (e.g. mobile or the first in the signature). Use "" if none found or ambiguous.
- **job_title:** Job title if stated (e.g. "VP of Sales"). Signatures frequently include title; prefer signature over body when both exist. Otherwise "".
- **company_name:** The company or organization the contact works for. Look in the contact's signature first, then: "company X", "at X", "X Inc", "X Corp", "X Ltd", or the most prominent organization name in the body. Capitalize properly. Do not infer from personal email domains (gmail, yahoo, etc.); leave "" unless stated.
- **company_domain:** The most likely official website domain for that company. Infer from company name (e.g. "Acme Corp" → "acme.com"). Use lowercase, no "www". Leave "" if company_name is unknown or the contact uses a consumer email domain.
- **city, state_region:** Location if mentioned (signature or body); otherwise "".
- **company_owner:** Another person at the company (e.g. owner, decision-maker) if mentioned—**not** the contact themselves. Leave "" if not stated or if the only person mentioned is the contact.

**Output format (JSON only):**
{"first_name": "", "last_name": "", "email": "", "phone": "", "job_title": "", "company_name": "", "company_domain": "", "city": "", "state_region": "", "company_owner": ""}

---
**Email to analyse (body may be truncated; extract only from the content provided):**

From: """ + (sender or "") + """
To: """ + (to or "") + """
Subject: """ + (subject or "") + """

Body:
""" + (body or "")[:14000]

    try:
        msg = client.messages.create(
            model=DEFAULT_MODEL,
            max_tokens=1024,
            temperature=0,
            messages=[{"role": "user", "content": prompt}],
        )
        block = msg.content[0] if msg.content else None
        if block and getattr(block, "text", None):
            parsed = _parse_json_block(block.text)
            if isinstance(parsed, dict):
                def s(v): return (v or "").strip() if v is not None else ""
                email_val = s(parsed.get("email"))
                # Normalize: extract address from "Display Name <addr@domain.com>"
                if email_val and "<" in email_val and ">" in email_val:
                    email_val = _extract_email_address(email_val)
                # Backend rule: when we know user_email, contact email is determined by direction.
                # Inbox (user received) → contact = sender → use From.
                # Sent (user sent) → contact = receiver → use To.
                if user_email and user_email.strip():
                    derived = _contact_email_from_direction(sender or "", to or "", user_email)
                    if derived:
                        email_val = derived
                result = {
                    "first_name": s(parsed.get("first_name")),
                    "last_name": s(parsed.get("last_name")),
                    "email": email_val,
                    "phone": s(parsed.get("phone")),
                    "job_title": s(parsed.get("job_title")),
                    "company_name": s(parsed.get("company_name")),
                    "company_domain": s(parsed.get("company_domain")),
                    "city": s(parsed.get("city")),
                    "state_region": s(parsed.get("state_region")),
                    "company_owner": s(parsed.get("company_owner")),
                }
                result = _confirm_company_from_contact_domain(result)
                return result
    except Exception as e:
        logger.exception("Claude extract_contact_from_email error: %s", e)
    return {
        "first_name": "",
        "last_name": "",
        "email": "",
        "phone": "",
        "job_title": "",
        "company_name": "",
        "company_domain": "",
        "city": "",
        "state_region": "",
        "company_owner": "",
    }


def generate_activity_note_from_email(
    sender: str,
    to: str,
    subject: str,
    body: str,
    user_email: str | None = None,
) -> str:
    """
    Use the full email (from, to, subject, body) as context and produce a brief
    activity note suitable for the activity Notes field, written from the user's
    perspective. The note states whether the user received or sent the email and
    what it mentions. user_email is the connected mailbox owner; when provided,
    direction (sent vs received) is determined so the note is phrased correctly.
    Returns plain text only (no JSON).
    """
    combined = (sender or "") + (to or "") + (subject or "") + (body or "")
    if not combined.strip():
        return ""
    client = _get_client()
    body_truncated = (body or "")[:14000]
    if len(body or "") > 14000:
        body_truncated += "\n\n[Content truncated for length.]"

    # Determine direction: user sent iff From address is the user's email
    sent_by_user = False
    if user_email and (sender or "").strip():
        from_addr = _extract_email_address(sender)
        if from_addr and from_addr.strip().lower() == user_email.strip().lower():
            sent_by_user = True

    direction_instruction: str
    if user_email and user_email.strip():
        if sent_by_user:
            direction_instruction = (
                "This email was SENT BY the user (From = user's address). You MUST write the opening as if the user is the subject: "
                "'Sent an email to [contact].' or 'Replied to [contact].' — where [contact] is the recipient's name (from the To header or body, e.g. 'Dear X'); never use an email address. "
                "Do NOT write 'Email from [user]' or mention the user's name; the note is the user's own log, so the user is implied. "
                "After the opening sentence, use 'It mentions that...' or 'It noted that...' to describe what was communicated."
            )
        else:
            direction_instruction = (
                "This email was RECEIVED BY the user (the user is in To; the sender is the other party). "
                "You MUST start with 'Received an email from [contact].' — where [contact] is the sender's name (from the From header or body); never use an email address. "
                "After the opening sentence, use 'It mentions that...' or 'It stated that...' to describe what was communicated."
            )
    else:
        direction_instruction = (
            "Infer from From/To who sent vs received. If the activity owner sent it: start with 'Sent an email to [contact]' (contact = recipient's name). "
            "If they received it: start with 'Received an email from [contact]' (contact = sender's name). Use only names, never email addresses; never mention the activity owner's name."
        )

    prompt = """You are an assistant that turns emails into brief, consistent activity notes for a CRM. The note is a first-person-style log entry: it describes what **the user** (the activity owner) did or received. The user is never named in the note—they are the implied subject.

**Rules (follow strictly):**

1. **Opening sentence — direction:**
""" + direction_instruction + """

2. **Never mention the user's name.** The note is the user's own activity log. When they sent the email, do NOT say "Email from [user name]" or "Email by [user name]". Say "Sent an email to [contact]." The contact is always the *other* party: if the user sent the email, contact = recipient (To); if the user received it, contact = sender (From).

3. **Never include any email address in the note.** Refer to the contact by **name only**. Use the contact's name when it appears in: (a) the From/To header display name (e.g. "Lakshmi B <...>"), or (b) the email body (e.g. "Dear Lakshmi B"). Do not invent or guess a contact name. If no name is available, do NOT fall back to the email address—instead write "Sent an email." or "Received an email." and continue with "It mentions that..." and the details. The note must never contain an email address (no @ or domain).

4. **Content:** After the opening, use "It mentions that...", "It stated that...", or "It noted that..." and in 1–3 sentences capture key points, requests, or outcomes. Past tense, neutral tone. If the email body explicitly mentions a date, time, or meeting time, include it in the note (e.g. "It mentions that the meeting is scheduled for Friday at 3pm.").

5. **Format:** Flowing prose only. No bullets, no "Note:", no JSON, no markdown. Typically 2–4 sentences. Output ONLY the note text.

---
Email to turn into an activity note (body may be truncated; base the note only on the content provided):

From: """ + (sender or "") + """
To: """ + (to or "") + """
Subject: """ + (subject or "") + """

Body:
""" + body_truncated

    try:
        msg = client.messages.create(
            model=DEFAULT_MODEL,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        text = _get_first_text_from_message(msg)
        if text and text.strip():
            return text.strip()
    except Exception as e:
        logger.exception("Claude generate_activity_note_from_email error: %s", e)
    return ""
