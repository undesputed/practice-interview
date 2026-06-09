from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)


def test_root_serves_new_shell():
    r = client.get("/")
    assert r.status_code == 200
    assert 'id="app"' in r.text
    assert "/main.js" in r.text


def test_clean_studio_css_served():
    r = client.get("/styles/clean-studio.css")
    assert r.status_code == 200
    assert "--green:#157a4c" in r.text


def test_router_and_shell_modules_served():
    for path in ("/router.js", "/shell.js", "/main.js",
                 "/api.js", "/screens/registry.js", "/screens/placeholder.js", "/util.js",
                 "/format.js", "/charts.js", "/screens/dashboard.js",
                 "/screens/history.js", "/screens/report.js"):
        assert client.get(path).status_code == 200, path


def test_legacy_app_preserved():
    r = client.get("/legacy.html")
    assert r.status_code == 200
    assert 'id="screen-start"' in r.text  # original start screen marker
