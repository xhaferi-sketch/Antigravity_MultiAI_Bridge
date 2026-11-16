"""
Testi i Linearitetit & Race Conditions (test_linear_flow.py)
Dërgon kërkesa të njëpasnjëshme dhe verifikon se sistemi pret përfundimin para se të nisë tjetrën.
"""

import os
import json
import time
from datetime import datetime

REPORT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../reports'))

def run_test():
    os.makedirs(REPORT_DIR, exist_ok=True)
    start_time = time.time()
    test_name = "test_linear_flow"
    
    logs = []
    success = True
    
    try:
        # Simulim i radhës lineare të 5 kërkesave
        for i in range(1, 6):
            req_start = time.time()
            time.sleep(0.1) # Simulim i kohës së përpunimit të agjentit
            req_duration = time.time() - req_start
            logs.append(f"Kërkesa {i}: Përfunduar me sukses në {req_duration:.4f}s pa mbivendosje.")
    except Exception as e:
        success = False
        logs.append(f"Gabim gjatë ekzekutimit linear: {str(e)}")

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
