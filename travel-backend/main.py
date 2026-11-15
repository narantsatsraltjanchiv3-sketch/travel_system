import logging
import os
import warnings
from datetime import date, datetime, timedelta, timezone
from typing import Literal, Optional

import bcrypt
import joblib
import jwt
import pandas as pd
import psycopg
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

# .env файлаас тохиргоо уншина
load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]
MODEL_PATH = os.getenv("MODEL_PATH")
JWT_SECRET = os.getenv("JWT_SECRET")
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL тохиргоо .env файлд алга байна")
if not JWT_SECRET or len(JWT_SECRET) < 32:
    raise RuntimeError("JWT_SECRET .env файлд алга эсвэл хэт богино байна (32+ тэмдэгт)")

logger = logging.getLogger("travel")

# ---------- Эрэлт таамаглах загвар ----------
# Colab-д сургасан баганын нэр, дараалал яг ижил байх ёстой
MODEL_FEATURES = ["price_per_day", "guide_experience", "days"]


def load_model():
    """MODEL_PATH-аас загварыг ачаална. Олдохгүй бол None (бусад хэсэг ажилласаар байна)."""
    if not MODEL_PATH:
        logger.warning("MODEL_PATH тохиргоо алга — таамаглал ажиллахгүй")
        return None
    # Харьцангуй замыг main.py-ийн хавтаснаас эхэлж тооцно
    path = MODEL_PATH if os.path.isabs(MODEL_PATH) else os.path.join(os.path.dirname(__file__), MODEL_PATH)
    try:
        with warnings.catch_warnings():
            # Colab (sklearn 1.6) ба энд суусан хувилбар зөрөхөд гарах анхааруулга.
            # LinearRegression-д үр дүн өөрчлөгдөхгүйг шалгасан.
            warnings.simplefilter("ignore")
            model = joblib.load(path)
        logger.info("Загвар ачаалагдлаа: %s", path)
        return model
    except Exception:
        logger.exception("Загвар ачаалж чадсангүй: %s", path)
        return None


model = load_model()


def predict_bookings(rows):
    """rows: [{price_per_day, guide_experience, days}, ...] → таамагласан захиалгын тоо.
    Сөрөг гарвал 0, 1 оронтой бутархай."""
    if model is None:
        raise HTTPException(status_code=503, detail="Таамаглах загвар ачаалагдаагүй байна")
    frame = pd.DataFrame(rows, columns=MODEL_FEATURES)
    return [round(max(0.0, float(v)), 1) for v in model.predict(frame)]


app = FastAPI(title="Travel Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


def get_connection():
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


@app.get("/health")
def health():
    return {"status": "ok"}


# Аяллын мэдээлэл + хөтчийн нэр + захиалгын тоо (шинэ нь хамгийн дээр)
TOURS_SELECT = """
    SELECT t.tour_id, t.name, t.destination, t.days, t.price, t.start_date,
           t.guide_id, g.full_name AS guide_name,
           (SELECT COUNT(*) FROM bookings b WHERE b.tour_id = t.tour_id) AS booking_count
    FROM tours t
    LEFT JOIN guides g ON g.guide_id = t.guide_id
"""


def db_error():
    return HTTPException(status_code=500, detail="Өгөгдлийн сантай холбогдож чадсангүй")


@app.get("/tours")
def get_tours():
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(TOURS_SELECT + " ORDER BY t.tour_id DESC")
                return cur.fetchall()
    except psycopg.Error:
        raise db_error()


# Имэйл олдоогүй үед ч bcrypt ажиллуулж, хариулах хугацааг ижил болгоно.
# Ингэснээр "энэ имэйл бүртгэлтэй юу" гэдгийг хугацаагаар нь тааж чадахгүй.
DUMMY_HASH = bcrypt.hashpw(b"dummy-password", bcrypt.gensalt(12))


class LoginRequest(BaseModel):
    email: str
    password: str


@app.post("/login")
def login(data: LoginRequest):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT admin_id, email, password_hash FROM admins WHERE email = %s",
                    (data.email.strip(),),
                )
                admin = cur.fetchone()
    except psycopg.Error:
        raise db_error()

    # Имэйл байхгүй эсвэл нууц үг буруу бол ижил 401 хариу өгнө
    stored_hash = admin["password_hash"].encode("utf-8") if admin else DUMMY_HASH
    password_ok = bcrypt.checkpw(data.password.encode("utf-8"), stored_hash)
    if not admin or not password_ok:
        raise HTTPException(status_code=401, detail="Имэйл эсвэл нууц үг буруу байна")

    payload = {
        "sub": str(admin["admin_id"]),
        "email": admin["email"],
        "exp": datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES),
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return {"access_token": token, "token_type": "bearer"}


bearer_scheme = HTTPBearer(auto_error=False)


def unauthorized(detail: str):
    # WWW-Authenticate толгой нь "Bearer токен хэрэгтэй" гэдгийг стандартаар мэдэгдэнэ
    return HTTPException(status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def require_admin(credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme)):
    """Authorization: Bearer <токен> толгойг шалгана. Дараах үед 401:
    - толгой байхгүй эсвэл "Bearer" биш
    - гарын үсэг буруу (хуурамч токен) эсвэл алгоритм нь HS256 биш
    - хугацаа дууссан, эсвэл exp/sub талбаргүй токен
    - токен эзэмшигч админ өгөгдлийн сангаас устгагдсан
    """
    if credentials is None:
        raise unauthorized("Нэвтрэх шаардлагатай")
    try:
        payload = jwt.decode(
            credentials.credentials,
            JWT_SECRET,
            algorithms=["HS256"],  # "none" зэрэг бусад алгоритмыг хүлээж авахгүй
            options={"require": ["exp", "sub"]},
        )
        admin_id = int(payload["sub"])
    except (jwt.PyJWTError, ValueError):
        raise unauthorized("Токен хүчингүй эсвэл хугацаа дууссан")

    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM admins WHERE admin_id = %s", (admin_id,))
                exists = cur.fetchone() is not None
    except psycopg.Error:
        raise db_error()
    if not exists:
        raise unauthorized("Админ эрх хүчингүй болсон")
    return payload


@app.get("/admin/stats")
def admin_stats(admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT
                        (SELECT COUNT(*) FROM tours) AS tours,
                        (SELECT COUNT(*) FROM bookings) AS bookings,
                        (SELECT COUNT(*) FROM bookings WHERE status = 'pending') AS pending,
                        (SELECT COALESCE(SUM(amount), 0) FROM payments) AS revenue
                    """
                )
                stats = cur.fetchone()

                cur.execute(
                    """
                    SELECT b.booking_id, b.booked_at, b.people,
                           t.name AS tour_name, c.full_name AS customer_name
                    FROM bookings b
                    LEFT JOIN tours t ON t.tour_id = b.tour_id
                    LEFT JOIN customers c ON c.customer_id = b.customer_id
                    WHERE b.status = 'pending'
                    ORDER BY b.booked_at DESC, b.booking_id DESC
                    LIMIT 5
                    """
                )
                pending_list = cur.fetchall()
    except psycopg.Error:
        raise db_error()

    stats["revenue"] = float(stats["revenue"])
    stats["pending_list"] = pending_list
    return stats


# ---------- Аялал: нэмэх / засах / устгах ----------
class TourIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    destination: Optional[str] = Field(default=None, max_length=50)
    days: Optional[int] = Field(default=None, ge=1)
    price: Optional[float] = Field(default=None, ge=0)
    start_date: Optional[date] = None
    guide_id: Optional[int] = None


def fetch_tour(cur, tour_id: int):
    cur.execute(TOURS_SELECT + " WHERE t.tour_id = %s", (tour_id,))
    return cur.fetchone()


@app.post("/tours", status_code=201)
def create_tour(tour: TourIn, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO tours (name, destination, days, price, start_date, guide_id)
                    VALUES (%(name)s, %(destination)s, %(days)s, %(price)s, %(start_date)s, %(guide_id)s)
                    RETURNING tour_id
                    """,
                    tour.model_dump(),
                )
                return fetch_tour(cur, cur.fetchone()["tour_id"])
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="Сонгосон хөтөч олдсонгүй")
    except psycopg.Error:
        raise db_error()


@app.put("/tours/{tour_id}")
def update_tour(tour_id: int, tour: TourIn, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE tours
                    SET name = %(name)s, destination = %(destination)s, days = %(days)s,
                        price = %(price)s, start_date = %(start_date)s, guide_id = %(guide_id)s
                    WHERE tour_id = %(tour_id)s
                    """,
                    {**tour.model_dump(), "tour_id": tour_id},
                )
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Аялал олдсонгүй")
                return fetch_tour(cur, tour_id)
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="Сонгосон хөтөч олдсонгүй")
    except psycopg.Error:
        raise db_error()


@app.delete("/tours/{tour_id}", status_code=204)
def delete_tour(tour_id: int, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS n FROM bookings WHERE tour_id = %s", (tour_id,))
                count = cur.fetchone()["n"]
                if count > 0:
                    raise HTTPException(
                        status_code=409,
                        detail=f"Энэ аялалд {count} захиалга бүртгэлтэй байгаа тул устгах боломжгүй. "
                               "Эхлээд захиалгуудыг нь устгах эсвэл өөр аялал руу шилжүүлнэ үү.",
                    )
                cur.execute("DELETE FROM tours WHERE tour_id = %s", (tour_id,))
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Аялал олдсонгүй")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=409, detail="Энэ аялалд захиалга бүртгэлтэй тул устгах боломжгүй")
    except psycopg.Error:
        raise db_error()


# ---------- Захиалга ----------
BookingStatus = Literal["pending", "confirmed", "cancelled"]

BOOKINGS_SELECT = """
    SELECT b.booking_id, b.tour_id, t.name AS tour_name,
           b.customer_id, c.full_name AS customer_name,
           b.people, b.booked_at, b.status,
           COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.booking_id = b.booking_id), 0) AS paid_amount
    FROM bookings b
    LEFT JOIN tours t ON t.tour_id = b.tour_id
    LEFT JOIN customers c ON c.customer_id = b.customer_id
"""


class BookingIn(BaseModel):
    tour_id: int
    customer_id: int
    people: int = Field(ge=1)
    status: BookingStatus = "pending"


class StatusIn(BaseModel):
    status: BookingStatus


def fetch_booking(cur, booking_id: int):
    cur.execute(BOOKINGS_SELECT + " WHERE b.booking_id = %s", (booking_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Захиалга олдсонгүй")
    return row


@app.get("/bookings")
def get_bookings(
    status: Optional[BookingStatus] = None,
    limit: int = Query(default=50, ge=1, le=500),
    admin: dict = Depends(require_admin),
):
    """Сүүлийн захиалгууд (анхдагчаар 50). ?status=pending гэж төлөвөөр шүүнэ."""
    where = " WHERE b.status = %(status)s" if status else ""
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    BOOKINGS_SELECT + where
                    + " ORDER BY b.booked_at DESC NULLS LAST, b.booking_id DESC LIMIT %(limit)s",
                    {"status": status, "limit": limit},
                )
                return cur.fetchall()
    except psycopg.Error:
        raise db_error()


@app.post("/bookings", status_code=201)
def create_booking(booking: BookingIn, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO bookings (tour_id, customer_id, people, status)
                    VALUES (%(tour_id)s, %(customer_id)s, %(people)s, %(status)s)
                    RETURNING booking_id
                    """,
                    booking.model_dump(),
                )
                return fetch_booking(cur, cur.fetchone()["booking_id"])
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="Сонгосон аялал эсвэл үйлчлүүлэгч олдсонгүй")
    except psycopg.Error:
        raise db_error()


@app.put("/bookings/{booking_id}")
def update_booking(booking_id: int, booking: BookingIn, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE bookings
                    SET tour_id = %(tour_id)s, customer_id = %(customer_id)s,
                        people = %(people)s, status = %(status)s
                    WHERE booking_id = %(booking_id)s
                    """,
                    {**booking.model_dump(), "booking_id": booking_id},
                )
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Захиалга олдсонгүй")
                return fetch_booking(cur, booking_id)
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=400, detail="Сонгосон аялал эсвэл үйлчлүүлэгч олдсонгүй")
    except psycopg.Error:
        raise db_error()


@app.patch("/bookings/{booking_id}/status")
def update_booking_status(booking_id: int, body: StatusIn, admin: dict = Depends(require_admin)):
    """Батлах (confirmed) эсвэл цуцлах (cancelled)."""
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE bookings SET status = %s WHERE booking_id = %s",
                    (body.status, booking_id),
                )
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Захиалга олдсонгүй")
                return fetch_booking(cur, booking_id)
    except psycopg.Error:
        raise db_error()


@app.delete("/bookings/{booking_id}", status_code=204)
def delete_booking(booking_id: int, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payments WHERE booking_id = %s",
                    (booking_id,),
                )
                paid = cur.fetchone()
                if paid["n"] > 0:
                    raise HTTPException(
                        status_code=409,
                        detail=f"Энэ захиалгад {float(paid['total']):,.0f} ₮ төлбөр бүртгэгдсэн тул устгах боломжгүй. "
                               "Оронд нь «Цуцлах»-ыг ашиглана уу.",
                    )
                cur.execute("DELETE FROM bookings WHERE booking_id = %s", (booking_id,))
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Захиалга олдсонгүй")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=409, detail="Төлбөртэй захиалгыг устгах боломжгүй. «Цуцлах»-ыг ашиглана уу.")
    except psycopg.Error:
        raise db_error()


# ---------- Үйлчлүүлэгч ----------
CUSTOMERS_SELECT = """
    SELECT c.customer_id, c.full_name, c.country, c.email,
           (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.customer_id) AS booking_count
    FROM customers c
"""

EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class CustomerIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=100)
    country: Optional[str] = Field(default=None, max_length=50)
    email: Optional[str] = Field(default=None, max_length=100, pattern=EMAIL_PATTERN)


def fetch_customer(cur, customer_id: int):
    cur.execute(CUSTOMERS_SELECT + " WHERE c.customer_id = %s", (customer_id,))
    return cur.fetchone()


def check_email_free(cur, email: Optional[str], exclude_id: Optional[int] = None):
    """Өөр үйлчлүүлэгч ижил имэйлтэй бол 409."""
    if not email:
        return
    cur.execute(
        "SELECT 1 FROM customers WHERE lower(email) = lower(%s) AND customer_id IS DISTINCT FROM %s",
        (email, exclude_id),
    )
    if cur.fetchone():
        raise HTTPException(status_code=409, detail="Энэ имэйлтэй үйлчлүүлэгч аль хэдийн бүртгэлтэй байна")


@app.get("/customers")
def get_customers(admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(CUSTOMERS_SELECT + " ORDER BY c.customer_id DESC")
                return cur.fetchall()
    except psycopg.Error:
        raise db_error()


@app.post("/customers", status_code=201)
def create_customer(customer: CustomerIn, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                check_email_free(cur, customer.email)
                cur.execute(
                    """
                    INSERT INTO customers (full_name, country, email)
                    VALUES (%(full_name)s, %(country)s, %(email)s)
                    RETURNING customer_id
                    """,
                    customer.model_dump(),
                )
                return fetch_customer(cur, cur.fetchone()["customer_id"])
    except psycopg.Error:
        raise db_error()


@app.put("/customers/{customer_id}")
def update_customer(customer_id: int, customer: CustomerIn, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                check_email_free(cur, customer.email, customer_id)
                cur.execute(
                    """
                    UPDATE customers
                    SET full_name = %(full_name)s, country = %(country)s, email = %(email)s
                    WHERE customer_id = %(customer_id)s
                    """,
                    {**customer.model_dump(), "customer_id": customer_id},
                )
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Үйлчлүүлэгч олдсонгүй")
                return fetch_customer(cur, customer_id)
    except psycopg.Error:
        raise db_error()


@app.delete("/customers/{customer_id}", status_code=204)
def delete_customer(customer_id: int, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS n FROM bookings WHERE customer_id = %s", (customer_id,))
                count = cur.fetchone()["n"]
                if count > 0:
                    raise HTTPException(
                        status_code=409,
                        detail=f"Энэ үйлчлүүлэгч {count} захиалгатай тул устгах боломжгүй. "
                               "Захиалгын түүх хадгалагдах ёстой.",
                    )
                cur.execute("DELETE FROM customers WHERE customer_id = %s", (customer_id,))
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Үйлчлүүлэгч олдсонгүй")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=409, detail="Энэ үйлчлүүлэгч захиалгатай тул устгах боломжгүй")
    except psycopg.Error:
        raise db_error()


# ---------- Хөтөч ----------
GUIDES_SELECT = """
    SELECT g.guide_id, g.full_name, g.language, g.experience_years,
           (SELECT COUNT(*) FROM tours t WHERE t.guide_id = g.guide_id) AS tour_count
    FROM guides g
"""


class GuideIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=100)
    language: Optional[str] = Field(default=None, max_length=30)
    experience_years: Optional[int] = Field(default=None, ge=0, le=80)


def fetch_guide(cur, guide_id: int):
    cur.execute(GUIDES_SELECT + " WHERE g.guide_id = %s", (guide_id,))
    return cur.fetchone()


@app.get("/guides")
def get_guides(admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(GUIDES_SELECT + " ORDER BY g.guide_id DESC")
                return cur.fetchall()
    except psycopg.Error:
        raise db_error()


@app.post("/guides", status_code=201)
def create_guide(guide: GuideIn, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO guides (full_name, language, experience_years)
                    VALUES (%(full_name)s, %(language)s, %(experience_years)s)
                    RETURNING guide_id
                    """,
                    guide.model_dump(),
                )
                return fetch_guide(cur, cur.fetchone()["guide_id"])
    except psycopg.Error:
        raise db_error()


@app.put("/guides/{guide_id}")
def update_guide(guide_id: int, guide: GuideIn, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE guides
                    SET full_name = %(full_name)s, language = %(language)s,
                        experience_years = %(experience_years)s
                    WHERE guide_id = %(guide_id)s
                    """,
                    {**guide.model_dump(), "guide_id": guide_id},
                )
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Хөтөч олдсонгүй")
                return fetch_guide(cur, guide_id)
    except psycopg.Error:
        raise db_error()


@app.delete("/guides/{guide_id}", status_code=204)
def delete_guide(guide_id: int, admin: dict = Depends(require_admin)):
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS n FROM tours WHERE guide_id = %s", (guide_id,))
                count = cur.fetchone()["n"]
                if count > 0:
                    raise HTTPException(
                        status_code=409,
                        detail=f"Энэ хөтөч {count} аялал хариуцаж байгаа тул устгах боломжгүй. "
                               "Эхлээд тэдгээр аялалд өөр хөтөч томилно уу.",
                    )
                cur.execute("DELETE FROM guides WHERE guide_id = %s", (guide_id,))
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="Хөтөч олдсонгүй")
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=409, detail="Энэ хөтөч аялал хариуцаж байгаа тул устгах боломжгүй")
    except psycopg.Error:
        raise db_error()


# ---------- Эрэлт таамаглах ----------
@app.get("/predict-demand")
def predict_demand(
    price_per_day: float = Query(ge=0),
    guide_experience: float = Query(ge=0, le=80),
    days: int = Query(ge=1, le=365),
    admin: dict = Depends(require_admin),
):
    prediction = predict_bookings(
        [{"price_per_day": price_per_day, "guide_experience": guide_experience, "days": days}]
    )[0]
    return {
        "price_per_day": price_per_day,
        "guide_experience": guide_experience,
        "days": days,
        "predicted_bookings": prediction,
    }


@app.get("/demand/tours")
def demand_tours(
    limit: int = Query(default=10, ge=1, le=150),
    admin: dict = Depends(require_admin),
):
    """Хамгийн их захиалгатай аяллууд: бодит захиалга + загварын таамаглал."""
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT t.tour_id, t.name, t.destination, t.days, t.price,
                           g.full_name AS guide_name,
                           COALESCE(g.experience_years, 0) AS guide_experience,
                           COUNT(b.booking_id) AS actual_bookings
                    FROM tours t
                    LEFT JOIN guides g ON g.guide_id = t.guide_id
                    LEFT JOIN bookings b ON b.tour_id = t.tour_id
                    GROUP BY t.tour_id, g.guide_id
                    ORDER BY actual_bookings DESC, t.tour_id
                    LIMIT %s
                    """,
                    (limit,),
                )
                tours = cur.fetchall()
    except psycopg.Error:
        raise db_error()

    # Үнэ эсвэл хоноггүй аялалд таамаглал хийх боломжгүй
    usable = [t for t in tours if t["price"] is not None and t["days"]]
    predictions = predict_bookings(
        [
            {
                "price_per_day": float(t["price"]) / t["days"],
                "guide_experience": float(t["guide_experience"]),
                "days": t["days"],
            }
            for t in usable
        ]
    ) if usable and model is not None else []  # Загвар байхгүй ч бодит тоо харагдана
    by_id = {t["tour_id"]: p for t, p in zip(usable, predictions)}

    for t in tours:
        t["price_per_day"] = round(float(t["price"]) / t["days"]) if t["tour_id"] in by_id else None
        t["predicted_bookings"] = by_id.get(t["tour_id"])
    return tours
