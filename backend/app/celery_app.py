from celery import Celery

from app.core.config import settings

celery_app = Celery("contact_resolution_workbench", broker=settings.CELERY_BROKER_URL)
celery_app.conf.update(
    task_ignore_result=True,
    task_serializer="json",
    accept_content=["json"],
    task_publish_retry=False,
    broker_connection_retry=False,
)
celery_app.autodiscover_tasks(["app"])
