export default async function handler(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    items: [
      {
        submission_id: "a9cb9edf-d6ed-4ddd-a7f9-6fbf9ad8dd3f",
        customer_email: "dbposhsports@gmail.com",
        cards: 2,
        totals: { grand: 46, grading: 40, evaluation: 6 },
        status: "submitted_paid",
        created_at: "2025-08-01T15:22:00.000Z",
        last_updated_at: "2025-08-11T20:10:00.000Z"
      },
      {
        submission_id: "b2f1c7a4-1234-4b55-8a88-09c5d3c9e111",
        customer_email: "user@example.com",
        cards: 3,
        totals: { grand: 84, grading: 75, evaluation: 9 },
        status: "intake_received",
        created_at: "2025-08-09T19:03:00.000Z",
        last_updated_at: "2025-08-12T13:40:00.000Z"
      }
    ]
  });
}
