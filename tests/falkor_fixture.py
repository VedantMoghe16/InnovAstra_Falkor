"""Shared FalkorDB fixture graph for graph-tool and agent tests."""

FIXTURE = """
CREATE
 (a:Account {id:'A', type:'individual', risk_score:0.9, pr:0.3, community:0, lp_community:0, source:'ibm'}),
 (b:Account {id:'B', type:'shell_company', risk_score:0.7, pr:0.2, community:0, lp_community:0, source:'ibm'}),
 (c:Account {id:'C', type:'individual', risk_score:0.5, pr:0.1, community:0, lp_community:0, source:'ibm'}),
 (d:Account {id:'D', type:'business', risk_score:0.2, pr:0.1, community:0, lp_community:0, source:'ibm'}),
 (e:Account {id:'E', type:'individual', risk_score:0.1, pr:0.1, community:0, lp_community:0, source:'ibm'}),
 (z:Account {id:'Z', type:'individual', risk_score:0.0, pr:0.01, community:1, lp_community:1, source:'ibm'}),
 (a)-[:TXN {tid:1, ts:1000,  amount:300000.0, rail:'RTGS', is_fraud:true,  ml_score:0.91}]->(b),
 (b)-[:TXN {tid:2, ts:2000,  amount:290000.0, rail:'RTGS', is_fraud:true,  ml_score:0.88}]->(c),
 (c)-[:TXN {tid:3, ts:3000,  amount:280000.0, rail:'NEFT', is_fraud:true,  ml_score:0.85}]->(a),
 (c)-[:TXN {tid:4, ts:3500,  amount:270000.0, rail:'NEFT', is_fraud:false, ml_score:0.40}]->(d),
 (d)-[:TXN {tid:5, ts:4000,  amount:260000.0, rail:'UPI',  is_fraud:false, ml_score:0.30}]->(e),
 (b)-[:TXN {tid:6, ts:500,   amount:10.0,     rail:'UPI',  is_fraud:false, ml_score:0.01}]->(e),
 (al1:Alert {alert_id:'AL1', pattern_type:'Circular Transaction', severity:'CRITICAL', confidence:90.0,
             tier:1, ml_score:0.91, total_flow:870000.0, description:'Round-trip cycle A->B->C->A'}),
 (al2:Alert {alert_id:'AL2', pattern_type:'ML-Detected Anomaly', severity:'HIGH', confidence:70.0,
             tier:2, ml_score:0.85, total_flow:270000.0, description:'ML anomaly on C->D'}),
 (al1)-[:FLAGS]->(a), (al1)-[:FLAGS]->(b), (al1)-[:FLAGS]->(c), (al2)-[:FLAGS]->(c),
 (i:Incident {incident_id:'INC-T1', primary_pattern:'Circular Transaction', severity:'CRITICAL',
              total_flow:870000.0, alert_count:2, n_entities:4}),
 (i)-[:CONTAINS]->(al1), (i)-[:CONTAINS]->(al2),
 (m1:Account {id:'ACC1', source:'identity', is_mule:true}),
 (m2:Account {id:'ACC2', source:'identity', is_mule:true}),
 (m3:Account {id:'ACC3', source:'identity', is_mule:true}),
 (dev:Device {id:'DEV-FARM'}), (kyc:KYC {id:'PAN-X'}),
 (m1)-[:USES]->(dev), (m2)-[:USES]->(dev), (m2)-[:HAS_KYC]->(kyc), (m3)-[:HAS_KYC]->(kyc),
 (p:Playbook {typology:'Circular Transaction', fatf_code:'ML-ROUNDTRIP', tool_sequence:'["find_cycles"]'}),
 (p2:Playbook {typology:'ML-Detected Anomaly', fatf_code:'ML-GENERIC', tool_sequence:'["trace_funds"]'})
"""
