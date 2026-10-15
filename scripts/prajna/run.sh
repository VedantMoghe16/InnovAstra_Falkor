#!/usr/bin/env bash
# Train on prajna and bring the artefacts back.
#   scripts/prajna/run.sh            # sync code → sbatch → wait → pull data/ibm_aml + data/ml/ibm_aml
# Requires an open SSH master connection (`ssh prajna` once; ControlPersist in ~/.ssh/config).
set -euo pipefail
cd "$(dirname "$0")/../.."
rsync -az --exclude .venv --exclude node_modules --exclude frontend/dist --exclude .git --exclude .claude \
  --exclude 'data/ibm_aml' --exclude 'data/ml' --exclude 'data/collusion' --exclude '__pycache__' ./ prajna:rudra/
JOB=$(ssh -o BatchMode=yes prajna 'bash -lc "cd ~/rudra && mkdir -p logs && sbatch --parsable scripts/prajna/train.sbatch"')
echo "submitted job $JOB"
while ssh -o BatchMode=yes prajna "bash -lc 'squeue -h -j $JOB'" | grep -q .; do sleep 30; done
ssh -o BatchMode=yes prajna "tail -30 ~/rudra/logs/train-$JOB.out"
mkdir -p data/ml
rsync -az prajna:rudra/data/ibm_aml/ data/ibm_aml/
rsync -az prajna:rudra/data/ml/ibm_aml/ data/ml/ibm_aml/
echo "artefacts pulled; reload the graph with scripts/load_falkor.sh"
