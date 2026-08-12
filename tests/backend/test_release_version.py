import unittest
from datetime import date

from scripts.next_calver import next_calver


class CalVerTests(unittest.TestCase):
    def test_first_release_of_month_starts_at_zero(self):
        self.assertEqual(next_calver(["v2.0.6"], date(2026, 8, 12)), "26.08.0")

    def test_next_release_uses_highest_micro(self):
        tags = ["v26.08.2", "v26.08.0", "v26.07.9", "v26.08.1-rc1", "Summer-2026"]
        self.assertEqual(next_calver(tags, date(2026, 8, 20)), "26.08.3")


if __name__ == "__main__":
    unittest.main()
