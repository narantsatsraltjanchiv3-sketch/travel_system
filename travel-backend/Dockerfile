# ---- Travel Backend (FastAPI) ----
FROM python:3.12-slim

# Python-ийн гаралтыг шууд лог руу, .pyc файл үүсгэхгүй
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 1. Сангуудыг суулгана (код өөрчлөгдөхөд энэ алхам дахин ажиллахгүй → хурдан build)
COPY requirements.txt .
RUN pip install -r requirements.txt

# 2. Код ба загварыг хуулна (.env image-д орохгүй — .dockerignore)
COPY main.py demand_model.joblib ./

# root биш хэрэглэгчээр ажиллуулна
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8000

# 3. uvicorn-оор 0.0.0.0:8000 дээр ажиллуулна
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
