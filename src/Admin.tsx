import { useState } from "react";

export default function Admin() {
  const [userId, setUserId] = useState("");
  const [plan, setPlan] = useState("month");
  const [expire, setExpire] = useState("");

  const createUser = async () => {
    console.log("CREATE USER CLICKED");

    try {
      const res = await fetch("/admin/create-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          password: "123456789",
          userId,
          plan,
          expire_at: expire
        })
      });

      console.log("STATUS:", res.status);

      const data = await res.json();

      console.log(data);

      alert(JSON.stringify(data));

    } catch (err) {
      console.error(err);
      alert("ERROR");
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>Admin Panel</h1>

      <input
        placeholder="User ID"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
      />

      <br />
      <br />

      <select
        value={plan}
        onChange={(e) => setPlan(e.target.value)}
      >
        <option value="day">Day</option>
        <option value="month">Month</option>
        <option value="year">Year</option>
      </select>

      <br />
      <br />

      <input
        type="date"
        value={expire}
        onChange={(e) => setExpire(e.target.value)}
      />

      <br />
      <br />

      <button onClick={createUser}>Create User</button>
    </div>
  );
}