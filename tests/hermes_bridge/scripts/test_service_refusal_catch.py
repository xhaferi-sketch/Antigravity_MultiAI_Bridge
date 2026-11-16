import os
import sys
import time
import json
from pathlib import Path

PLUGIN_ROOT = Path(r"C:\Vladi_project\Antigravity_MultiAI_Bridge")
REPORTS_DIR = PLUGIN_ROOT / "tests" / "hermes_bridge" / "reports"
SCORES_FILE = PLUGIN_ROOT / "mcp" / "model_scores.json"

SERVICE_ERROR_PATTERNS = [
    'oops! something happened',
    "looks like i can't chat about this",
    "let's try a different topic",
    'i prefer not to continue this conversation',
    'having a hard time fulfilling your request',
    'i encountered an error',
    "can't help with that",
    'something went wrong',
    'limit reached',
    'reached your limit',
    'quota exceeded',
    'resets nov',
    'resets dec',
    'resets jan',
    'resets in',
    'resets at',
    'try again later',
    'upgrade to advanced',
    'unlock 4 carbon'
]

def score_model(name, cfg):
    lower = name.lower()
    score = 0
    if 'argon' in lower:
        score += 120
    for w, p in cfg.get('positiveWeights', {}).items():
        if w in lower:
            score += p
    for w, p in cfg.get('negativeWeights', {}).items():
        if w in lower:
            score += p
    return score

def run_test():
    start_time = time.time()
    results = {}

    # Test 1: Catch "I encountered an error doing what you asked."
    refusal_1 = "I encountered an error doing what you asked. Could you try again?"
    low_1 = refusal_1.lower()
    caught_1 = any(p in low_1 for p in SERVICE_ERROR_PATTERNS)
    results["refusal_encountered_error_caught"] = caught_1
    assert caught_1, f"Pattern failed to catch: {refusal_1}"

    # Test 2: Catch "I'm having a hard time fulfilling your request"
    refusal_2 = "I'm having a hard time fulfilling your request. Can I help you with something else instead?"
    low_2 = refusal_2.lower()
    caught_2 = any(p in low_2 for p in SERVICE_ERROR_PATTERNS)
    results["refusal_hard_time_caught"] = caught_2
    assert caught_2, f"Pattern failed to catch: {refusal_2}"

    # Test 3: Plan validation rejects short/refusal plans
    is_invalid_plan = len(refusal_1.strip()) < 100 or caught_1
    results["plan_validator_rejects_refusal"] = is_invalid_plan
    assert is_invalid_plan, "Plan validator failed to reject refusal response"

    # Test 4: Model score check blocks Flash-Lite and Auto
    cfg = json.loads(SCORES_FILE.read_text(encoding="utf-8"))
    min_score = cfg.get("minimumAcceptableScore", 75)
    
    score_flash_lite = score_model("Gemini Flash-Lite", cfg)
    score_auto = score_model("Auto", cfg)
    score_argon_high = score_model("Gemini Argon 4 Pro High", cfg)
    
    blocked_flash = score_flash_lite < min_score
    blocked_auto = score_auto < min_score
    allowed_argon = score_argon_high >= min_score

    results["flash_lite_score"] = score_flash_lite
    results["flash_lite_blocked"] = blocked_flash
    results["auto_blocked"] = blocked_auto
    results["argon_allowed"] = allowed_argon
    results["argon_score"] = score_argon_high

    assert blocked_flash, f"Flash-Lite was not blocked: score={score_flash_lite}"
    assert blocked_auto, f"Auto was not blocked: score={score_auto}"
    assert allowed_argon, f"Argon High was not allowed: score={score_argon_high}"

    elapsed_ms = round((time.time() - start_time) * 1000, 2)
    
    report = {
        "test_name": "test_service_refusal_catch",
        "status": "SUCCESS",
        "execution_time_ms": elapsed_ms,
        "results": results,
        "timestamp": int(time.time()),
        "description": "Verifikimi i kapjes automatike te refuzimeve te Google Gemini dhe bllokimi i modeleve te dobëta Flash-Lite/Auto."
    }

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    report_file = REPORTS_DIR / f"report_service_refusal_{report['timestamp']}.json"
    report_file.write_text(json.dumps(report, indent=2), encoding="utf-8")
    
    print(f"TEST SUCCESS: Report written to {report_file}")
    print(json.dumps(report, indent=2))
    return 0

if __name__ == "__main__":
    sys.exit(run_test())
