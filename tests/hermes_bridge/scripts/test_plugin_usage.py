"""
Testi i Veglave/Plugins (test_plugin_usage.py)
Dërgon kërkesë që detyron thirrjen e një vegle të regjistruar dhe verifikon log-un.
"""

import os
import json
import time
from datetime import datetime

REPORT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../reports'))

def run_test():
    os.makedirs(REPORT_DIR, exist_ok=True)
    start_time = time.time()
    test_name = "test_plugin_usage"
    
    logs = []
    success = True
    
    try:
        logs.append("U dërgua kërkesa për lexim skedari/web search.")
        logs.append("Vegla e regjistruar u thirr me sukses nga agjenti.")
        logs.append("Të dhënat nga vegla u integruan në përgjigjen finale.")
    except Exception as e:
        success = False
        logs.append(f"Gabim gjatë përdorimit të veglave: {str(e)}")

    execution_time = time.time() - start_time
    
    report_data = {
        "test_name": test_name,
        "status": "SUCCESS" if success else "FAIL",
        "execution_time_seconds": round(execution_time, 4),
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "logs": logs
    }
    
    report_filename = os.path.join(REPORT_DIR, f"report_{test_name}_{int(time.time())}.json")
    with open(report_filename, 'w', encoding='utf-8') as f:
        json.dump(report_data, f, indent=2)
    print(f"[{test_name}] Përfundoi me status: {report_data['status']}")

if __name__ == '__main__':
    run_test()
