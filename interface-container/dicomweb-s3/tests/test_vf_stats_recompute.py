"""_recompute_vf_stats writes a 36-char virtual_folder_statistics.id.

virtual_folder_statistics.id is VARCHAR(36). The recompute used to bind
'vfstats-<vf uuid>' (44 chars), which strict-mode MySQL rejects with 1406 Data
too long; the error was swallowed as a warning, so STOW / unassign never
refreshed the folder's counts. The id now comes from MySQL's UUID().

The fake below renders the statement the way pymysql does (sql % escaped
params, so a stray literal '%' or a placeholder-count mismatch fails here too)
and enforces the column width on the id the INSERT .. SELECT produces.
"""
import logging
import re

import pytest

VF = "aaaaaaaa-0000-4000-8000-0000000000aa"
ID_WIDTH = 36
SKIPPED = "VF stats recompute skipped"


def _render(sql, params):
    """pymysql-style client-side interpolation."""
    def lit(v):
        return "'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'"
    return sql % tuple(lit(p) for p in params)


class StrictStatsWrite:
    def __init__(self):
        self.statements = []

    def __call__(self, sql, params):
        rendered = _render(sql, params)
        self.statements.append(rendered)
        m = re.search(r"INSERT INTO virtual_folder_statistics\s*\(\s*id\s*,.*?\)\s*SELECT\s+(.+?),",
                      rendered, re.S)
        assert m, rendered
        id_expr = m.group(1).strip()
        if id_expr.startswith("'"):
            value = id_expr[1:-1]
            if len(value) > ID_WIDTH:
                raise RuntimeError("(1406, \"Data too long for column 'id' at row 1\")")
        else:
            assert id_expr == "UUID()", id_expr      # 36 chars by definition
        return 1


@pytest.fixture
def strict_write(service, monkeypatch):
    w = StrictStatsWrite()
    monkeypatch.setattr(service.main, "_execute_write", w)
    return w


def test_recompute_inserts_without_a_data_too_long_error(service, strict_write, caplog):
    with caplog.at_level(logging.WARNING):
        service.main._recompute_vf_stats(VF)
    assert [r for r in caplog.records if SKIPPED in r.getMessage()] == []
    (stmt,) = strict_write.statements
    assert "SELECT UUID(), '%s'" % VF in stmt
    assert stmt.count("'%s'" % VF) == 2           # virtual_folder_id + WHERE
    assert "vfstats-" not in stmt


def test_the_fake_rejects_the_old_44_char_id(strict_write):
    """Guard: the strict fake would have caught the original bug."""
    old = ("INSERT INTO virtual_folder_statistics (id, virtual_folder_id) "
           "SELECT %s, %s FROM virtual_folder_assignments WHERE virtual_folder_id = %s")
    assert len(f"vfstats-{VF}") == 44
    with pytest.raises(RuntimeError, match="Data too long for column 'id'"):
        strict_write(old, (f"vfstats-{VF}", VF, VF))


def test_a_db_failure_is_still_best_effort(service, monkeypatch, caplog):
    def boom(sql, params):
        raise RuntimeError("db down")
    monkeypatch.setattr(service.main, "_execute_write", boom)
    with caplog.at_level(logging.WARNING):
        service.main._recompute_vf_stats(VF)              # never raises
    assert len([r for r in caplog.records if SKIPPED in r.getMessage()]) == 1
