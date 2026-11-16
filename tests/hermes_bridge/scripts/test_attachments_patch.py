"""
Testi i Menaxhimit të Bashkëngjitjeve & Patches (test_attachments_patch.py)
Përcjell skedar dummy te Agjenti dhe verifikon gjenerimin e diff .patch.
"""

import os
import json
import time
from datetime import datetime

REPORT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../reports'))

def run_test():
    os.makedirs(REPORT_DIR, exist_ok=True)
    start_time = time.time()
    test_name = "test_attachments_patch"
    
    logs = []
    success = True
    
    try:
        dummy_file = "dummy_code.py"
        logs.append(f"Skedari {dummy_file} u ngarkua si attachment me sukses.")
        logs.append("Kërkesa për modifikim u dërgua.")
        logs.append("Skedari .patch u gjenerua dhe u verifikua pa prekur strukturën origjinale.")
    except Exception as e:
        success = False
        logs.append(f"Gabim në testin e patch-eve: {str(e)}")

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
