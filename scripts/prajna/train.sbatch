#!/bin/bash
# Full RUDRA pipeline (detectors + XGBoost + GraphSAGE + TGN + stacked ensemble + ML/rule fuse)
# on one GPU of the prajna cluster.   Submit:  sbatch scripts/prajna/train.sbatch
#SBATCH --job-name=rudra-train
#SBATCH --partition=a40
#SBATCH --qos=a40
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=03:00:00
#SBATCH --output=logs/train-%j.out

set -euo pipefail
cd "$HOME/rudra"
mkdir -p logs
PY="$HOME/miniforge3/envs/rudra/bin/python"
export PYTHONUNBUFFERED=1
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-$SLURM_CPUS_PER_TASK}"
echo "node=$(hostname) gpus=$CUDA_VISIBLE_DEVICES threads=$OMP_NUM_THREADS start=$(date)"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true
"$PY" -c "import torch; print('torch', torch.__version__, 'cuda available', torch.cuda.is_available())"
time "$PY" src/run_pipeline.py --dataset ibm_aml ${RUDRA_TRAIN_ARGS:---force-retrain-ml} 2>&1 \
  | grep -vE "it/s\]$"
echo "done=$(date)"
