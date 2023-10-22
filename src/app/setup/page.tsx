import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function Setup() {
  const [data, setData] = useState(null);
  const searchParams = useSearchParams();
  const installationId = searchParams.get("installation_id");

  useEffect(() => {
    // Use the fetch API to make an HTTP GET request to an external API
    fetch("/api/github/repositories?installation_id=" + installationId)
      .then((response) => response.json())
      .then((data) => {
        setData(data);
      })
      .catch((error) => {
        console.error("Error fetching data:", error);
      });
  }, []);

  return (
    <>
      <div>installation_id: {installationId}</div>
      {data ? (
        <pre>{JSON.stringify(data, null, 2)}</pre>
      ) : (
        <p>Loading data...</p>
      )}
    </>
  );
}
