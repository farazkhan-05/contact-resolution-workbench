from pydantic import BaseModel


class UserResponse(BaseModel):
    id: str
    is_anonymous: bool


class WorkspaceResponse(BaseModel):
    id: str
    name: str
    role: str


class AuthBootstrapResponse(BaseModel):
    user: UserResponse
    workspaces: list[WorkspaceResponse]
