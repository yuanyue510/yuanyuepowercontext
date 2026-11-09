FROM python:3.11-slim

ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
EXPOSE 5000
CMD ["python", "app.py"]
