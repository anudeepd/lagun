from lagun.limits import QUERY_MAX_RESULT_ROWS
from lagun.models.query import QueryRequest
from lagun.models.session import SessionCreate


def test_query_requests_accept_limits_above_the_old_100k_ceiling():
    assert QUERY_MAX_RESULT_ROWS > 100_000

    request = QueryRequest(sql="SELECT 1", limit=QUERY_MAX_RESULT_ROWS)
    session = SessionCreate(
        name="Large result",
        username="reader",
        query_limit=QUERY_MAX_RESULT_ROWS,
    )

    assert request.limit == QUERY_MAX_RESULT_ROWS
    assert session.query_limit == QUERY_MAX_RESULT_ROWS
