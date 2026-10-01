# Содержимое WSGI-файла для PythonAnywhere.
# Вкладка Web → ссылка "WSGI configuration file" → удалить всё, что там есть, и вставить это.
# Замените ВАШ_ЛОГИН на ваш логин PythonAnywhere.
import sys

path = "/home/ВАШ_ЛОГИН/kormikota"
if path not in sys.path:
    sys.path.insert(0, path)

from app import app as application  # noqa: E402,F401
