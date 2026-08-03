import Foundation

actor APIClient: HealthRiskAPI {
    private let baseURL: URL
    private let session: any URLSessioning
    private let retryPolicy: RetryPolicy
    private let sleeper: any RetrySleeping
    private var bearerToken: String?

    init(
        baseURL: URL,
        session: any URLSessioning = URLSession.shared,
        retryPolicy: RetryPolicy = .standard,
        sleeper: any RetrySleeping = TaskRetrySleeper(),
        bearerToken: String? = nil
    ) {
        self.baseURL = baseURL
        self.session = session
        self.retryPolicy = retryPolicy
        self.sleeper = sleeper
        self.bearerToken = bearerToken
    }

    func setBearerToken(_ token: String?) {
        bearerToken = token
    }

    func metadata() async throws -> APIMetadata {
        try await get("/api/meta")
    }

    func login(_ request: AuthRequest) async throws -> AuthResponse {
        try await post("/api/auth/login", body: request)
    }

    func signup(_ request: AuthRequest) async throws -> AuthResponse {
        try await post("/api/auth/signup", body: request)
    }

    func currentUser() async throws -> CurrentUserResponse {
        try await get("/api/auth/me")
    }

    func logout() async throws {
        let _: OkResponse = try await post("/api/auth/logout")
    }

    func listGames() async throws -> ListGamesResponse {
        try await get("/api/games")
    }

    func createGame(_ request: CreateGameRequest) async throws -> GameView {
        try await post("/api/games", body: request)
    }

    func getGame(_ gameId: String) async throws -> LobbyGameView {
        try await get("/api/games/\(encodedPathComponent(gameId))")
    }

    func updateLobbyHealthRules(
        gameId: String,
        request: HealthRulesUpdateRequest
    ) async throws -> LobbyGameMutationResponse {
        try await post(
            "/api/games/\(encodedPathComponent(gameId))/health-rules/propose",
            body: request
        )
    }

    func submitLobbyHealthChoices(
        gameId: String,
        request: LobbyHealthChoicesRequest
    ) async throws -> LobbyGameMutationResponse {
        try await post(
            "/api/games/\(encodedPathComponent(gameId))/lobby-health-votes",
            body: request
        )
    }

    private func get<Response: Decodable & Sendable>(_ path: String) async throws -> Response {
        try await send(path: path, method: "GET", body: nil, idempotencyKey: nil)
    }

    private func encodedPathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }

    private func post<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        _ path: String,
        body: Body
    ) async throws -> Response {
        let encodedBody: Data
        do {
            encodedBody = try JSONEncoder().encode(body)
        } catch {
            throw APIError(
                statusCode: nil,
                code: "encoding_error",
                message: "The request could not be prepared.",
                requestId: nil,
                retryable: false
            )
        }

        // The key belongs to this logical mutation. send(...) may attempt the
        // same request more than once, but a later post(...) call gets a new key.
        return try await send(
            path: path,
            method: "POST",
            body: encodedBody,
            idempotencyKey: UUID()
        )
    }

    private func post<Response: Decodable & Sendable>(_ path: String) async throws -> Response {
        try await send(
            path: path,
            method: "POST",
            body: nil,
            idempotencyKey: UUID()
        )
    }

    private func send<Response: Decodable & Sendable>(
        path: String,
        method: String,
        body: Data?,
        idempotencyKey: UUID?
    ) async throws -> Response {
        var attempt = 0

        while true {
            attempt += 1
            let clientRequestId = UUID().uuidString
            let request = try makeRequest(
                path: path,
                method: method,
                body: body,
                clientRequestId: clientRequestId,
                idempotencyKey: idempotencyKey
            )

            do {
                return try await perform(request, clientRequestId: clientRequestId)
            } catch let error as APIError {
                guard retryPolicy.shouldRetry(error, afterAttempt: attempt) else {
                    throw error
                }
                await sleeper.sleep(for: retryPolicy.delay)
            } catch {
                throw APIError.normalized(error)
            }
        }
    }

    private func makeRequest(
        path: String,
        method: String,
        body: Data?,
        clientRequestId: String,
        idempotencyKey: UUID?
    ) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw APIError(
                statusCode: nil,
                code: "invalid_url",
                message: "The server URL is invalid.",
                requestId: clientRequestId,
                retryable: false
            )
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(clientRequestId, forHTTPHeaderField: "X-Request-Id")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        if let idempotencyKey {
            request.setValue(idempotencyKey.uuidString, forHTTPHeaderField: "Idempotency-Key")
        }
        return request
    }

    private func perform<Response: Decodable & Sendable>(
        _ request: URLRequest,
        clientRequestId: String
    ) async throws -> Response {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network(requestId: clientRequestId)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError(
                statusCode: nil,
                code: "invalid_response",
                message: "The HealthRisk server returned an invalid response.",
                requestId: clientRequestId,
                retryable: true
            )
        }

        let responseRequestId = httpResponse.value(forHTTPHeaderField: "X-Request-Id")
            ?? clientRequestId

        guard (200..<300).contains(httpResponse.statusCode) else {
            let payload = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
            throw APIError(
                statusCode: httpResponse.statusCode,
                code: payload?.error ?? "http_\(httpResponse.statusCode)",
                message: payload?.message ?? "The request failed.",
                requestId: payload?.requestId ?? responseRequestId,
                retryable: payload?.retryable ?? (500..<600).contains(httpResponse.statusCode)
            )
        }

        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw APIError(
                statusCode: httpResponse.statusCode,
                code: "decoding_error",
                message: "The HealthRisk response could not be read.",
                requestId: responseRequestId,
                retryable: false
            )
        }
    }
}
